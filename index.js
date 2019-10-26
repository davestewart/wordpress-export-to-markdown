const fs = require('fs')
const luxon = require('luxon')
const minimist = require('minimist')
const path = require('path')
const request = require('request')
const turndown = require('turndown')
const xml2js = require('xml2js')
const YAML = require('yaml')

// ---------------------------------------------------------------------------------------------------------------------
// utils
// ---------------------------------------------------------------------------------------------------------------------

function isObject (value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function isEmpty (value) {
  if (Array.isArray(value)) {
    return value.filter(value => !!value).length === 0
  }
  if (isObject(value)) {
    return Object.keys(value).length === 0
  }
  return value === null || typeof value === 'undefined' || value === ''
}

function clean (input) {
  if (Array.isArray(input)) {
    return input
      .map(value => clean(value))
      .filter(value => !isEmpty(value))
  }

  if (isObject(input)) {
    return Object
      .keys(input)
      .reduce((output, key) => {
        let value = input[key]
        if (!isEmpty(value)) {
          value = clean(value)
          if (!isEmpty(value)) {
            output[key] = value
          }
        }
        return output
      }, {})
  }

  return input
}

function readFile (path) {
  try {
    return fs.readFileSync(path, 'utf8')
  } catch (ex) {
    console.log('Unable to read file.')
    console.log(ex.message)
  }
}

function getItemsOfType (data, type) {
  return data.rss.channel[0].item.filter(item => item.post_type[0] === type)
}

function getFilenameFromUrl (url) {
  return url.split('/').slice(-1)[0]
}

function createDir (dir) {
  try {
    fs.accessSync(dir, fs.constants.F_OK)
  } catch (ex) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------------------------------------------------

function parseFileContent (content) {
  const processors = { tagNameProcessors: [xml2js.processors.stripPrefix] }
  xml2js.parseString(content, processors, (err, data) => {
    if (err) {
      console.log('Unable to parse file content.')
      console.log(err)
    } else {
      processData(data)
    }
  })
}

function processData (data) {
  const baseUrl = data.rss.channel[0].base_site_url[0]
  images = collectImages(data)
  authors = collectAuthors(data)
  posts = collectPosts(data, authors)
  mergeImagesIntoPosts(images, posts)
  writeFiles(posts)
}

function collectImages (data) {
  // start by collecting all attachment images
  let images = getItemsOfType(data, 'attachment')
  // filter to certain image file types
    .filter(attachment => (/\.(gif|jpg|jpeg|png)$/i).test(attachment.attachment_url[0]))
    .map(attachment => ({
      id: attachment.post_id[0],
      postId: attachment.post_parent[0],
      url: attachment.attachment_url[0]
    }))

  // optionally add images scraped from <img> tags in post content
  if (argv.addcontentimages) {
    addContentImages(data, images)
  }

  return images
}

function addContentImages (data, images) {
  let regex = (/<img[^>]*src="(.+?\.(?:gif|jpg|jpeg|png))"[^>]*>/gi)
  let match

  getItemsOfType(data, 'post').forEach(post => {
    let postId = post.post_id[0]
    let postContent = post.encoded[0]
    let postLink = post.link[0]

    // reset lastIndex since we're reusing the same regex object
    regex.lastIndex = 0
    while ((match = regex.exec(postContent)) !== null) {
      // base the matched image URL relative to the post URL
      let url = new URL(match[1], postLink).href

      // add image if it hasn't already been added for this post
      let exists = images.some(image => image.postId === postId && image.url === url)
      if (!exists) {
        images.push({
          id: -1,
          postId: postId,
          url: url
        })
        console.log('Scraped: ' + url)
      }
    }
  })
}

function collectAuthors (data) {
  return data.rss.channel[0].author.map(item => ({
    id: item.author_login[0],
    name: item.author_display_name[0]
  }))
}

function collectPosts (data, authors) {
  // this is passed into getPostContent() for the markdown conversion
  turndownService = initTurndownService()

  return getItemsOfType(data, 'post')
    .filter(post => {
      return argv.filter
        ? getPostTitle(post).toLowerCase().indexOf(argv.filter.toLowerCase()) > -1
        : true
    })
    .map(post => {
      const title = getPostTitle(post)
      console.log('Processing: ' + title)
      return {
        // meta data isn't written to file, but is used to help with other things
        meta: {
          id: getPostId(post),
          slug: getPostSlug(post),
          path: getPostPath(post),
          status: getPostStatus(post),
          thumbnailImageId: getPostThumbnailImage(post),
          featureImageId: getPostFeatureImage(post)
        },
        frontmatter: {
          slug: getPostSlug(post),
          title,
          summary: getPostExcerpt(post),
          author: getAuthorName(authors, getPostAuthor(post)),
          date: getPostDate(post),
          images: {},
          categories: getCategories(post),
          tags: getTags(post),
          meta: getMeta(post),
        },
        content: getPostContent(post, turndownService)
      }
    })
}

function initTurndownService () {
  let turndownService = new turndown({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced'
  })

  // preserve embedded tweets
  turndownService.addRule('tweet', {
    filter: node => node.nodeName === 'BLOCKQUOTE' && node.getAttribute('class') === 'twitter-tweet',
    replacement: (content, node) => '\n\n' + node.outerHTML
  })

  // preserve embedded codepens
  turndownService.addRule('codepen', {
    filter: node => {
      // codepen embed snippets have changed over the years
      // but this series of checks should find the commonalities
      return (
        ['P', 'DIV'].includes(node.nodeName) &&
        node.attributes['data-slug-hash'] &&
        node.getAttribute('class') === 'codepen'
      )
    },
    replacement: (content, node) => '\n\n' + node.outerHTML
  })

  // preserve embedded scripts (for tweets, codepens, gists, etc.)
  turndownService.addRule('script', {
    filter: 'script',
    replacement: (content, node) => {
      let before = '\n\n'
      let src = node.getAttribute('src')
      if (node.previousSibling && node.previousSibling.nodeName !== '#text') {
        // keep twitter and codepen <script> tags snug with the element above them
        before = '\n'
      }
      let html = node.outerHTML.replace('async=""', 'async')
      return before + html + '\n\n'
    }
  })

  // preserve iframes (common for embedded audio/video)
  turndownService.addRule('iframe', {
    filter: 'iframe',
    replacement: (content, node) => {
      let html = node.outerHTML
        .replace('allowfullscreen=""', 'allowfullscreen')
      return '\n\n' + html + '\n\n'
    }
  })

  return turndownService
}

// ---------------------------------------------------------------------------------------------------------------------
// post
// ---------------------------------------------------------------------------------------------------------------------

function getPostId (post) {
  return post.post_id[0]
}

function getPostSlug (post) {
  return post.post_name[0] || post.post_id[0]
}

function getPostPath (post) {
  return post.link[0].replace(/https?:\/\/[^/]+/, '').replace(/^\/|\/$/g, '')
}

function getPostDate (post) {
  return luxon.DateTime.fromRFC2822(post.pubDate[0], { zone: 'utc' }).toISODate()
}

function getPostStatus (post) {
  return post.status[0]
}

function getPostTitle (post) {
  return post.title[0].trim()
}

function getPostExcerpt (post) {
  return (post.encoded[1] || '').trim()
}

function getAuthorName (authors, id) {
  return authors.find(item => item.id === id).name
}

function getPostAuthor (post) {
  return post.creator[0]
}

function getCategories (post) {
  return (post.category || []).reduce((output, item) => {
    if (item.$.domain === 'category') {
      output.push(item._.toLowerCase().trim())
    }
    return output
  }, [])
}

function getTags (post) {
  return (post.category || []).reduce((output, item) => {
    if (item.$.domain === 'post_tag') {
      output.push(item._.toLowerCase().trim())
    }
    return output
  }, [])
}

function getMeta (post) {
  return (post.postmeta || []).reduce((output, item) => {
    const key = item.meta_key[0].replace(/^_/, '')
    if (key in metaKeys) {
      const value = item.meta_value[0]
      if (value) {
        const transform = metaKeys[key]
        output[key] = typeof transform === 'function'
          ? transform(value)
          : value
      }
    }
    return output
  }, {})
}

function getPostThumbnailImage (post) {
  if (post.postmeta === undefined) return
  let postmeta = post.postmeta.find(postmeta => postmeta.meta_key[0] === '_thumbnail_id')
  return postmeta && postmeta.meta_value[0]
}

function getPostFeatureImage (post) {
  if (post.postmeta === undefined) return
  let postmeta = post.postmeta.find(postmeta => postmeta.meta_key[0] === 'post_medium_thumbnail_id')
  return postmeta && postmeta.meta_value[0]
}

function getPostContent (post, turndownService) {
  let content = post.encoded[0].trim()

  // insert an empty div element between double line breaks
  // this nifty trick causes turndown to keep adjacent paragraphs separated
  // without mucking up content inside of other elemnts (like <code> blocks)
  content = content.replace(/(\r?\n){2}/g, '\n<div></div>\n')

  if (argv.addcontentimages) {
    // writeImageFile() will save all content images to a relative /images
    // folder so update references in post content to match
    content = content.replace(/(<img[^>]*src=").*?([^\/"]+\.(?:gif|jpg|jpeg|png))("[^>]*>)/gi, '$1images/$2$3')
  }

  // this is a hack to make <iframe> nodes non-empty by inserting a "." which
  // allows the iframe rule declared in initTurndownService() to take effect
  // (using turndown's blankRule() and keep() solution did not work for me)
  content = content.replace(/(<\/iframe>)/gi, '.$1')

  // use turndown to convert HTML to Markdown
  content = turndownService.turndown(content)

  // clean up extra spaces in list items
  content = content.replace(/(-|\d+\.) +/g, '$1 ')

  // clean up the "." from the iframe hack above
  content = content.replace(/\.(<\/iframe>)/gi, '$1')

  return content
}

function mergeImagesIntoPosts (images, posts) {
  // create lookup table for quicker traversal
  let postsLookup = posts.reduce((lookup, post) => {
    lookup[post.meta.id] = post
    return lookup
  }, {})

  images.forEach(image => {
    let post
    // get post through thumbnail ID first
    post = posts.filter(o => o.meta.thumbnailImageId === image.id)[0]
    if (!post) {
      // include other images with post id as parent id as well
      post = postsLookup[image.postId]
    }
    if (post) {
      // save full image URLs for downloading later
      post.meta.imageUrls = post.meta.imageUrls || []
      post.meta.imageUrls.push(image.url)

      // save cover image filename to frontmatter
      if (image.id === post.meta.thumbnailImageId) {
        post.frontmatter.images.thumbnail = './images/' + getFilenameFromUrl(image.url)
      }

      if (image.id === post.meta.featureImageId) {
        post.frontmatter.images.feature = './images/' + getFilenameFromUrl(image.url)
      }
    }
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------------------------------------------------

function writeFiles (posts) {
  let delay = 0
  posts.forEach(post => {
    const postDir = getPostDir(post)
    createDir(postDir)
    writeMarkdownFile(post, postDir)

    if (argv.saveimages && post.meta.imageUrls) {
      post.meta.imageUrls.forEach(imageUrl => {
        const imageDir = path.join(postDir, 'images')
        createDir(imageDir)
        writeImageFile(imageUrl, imageDir, delay)
        delay += 25
      })
    }
  })
}

function writeMarkdownFile (post, postDir) {
  const frontmatter = clean(post.frontmatter)
  const data = '---\n' + YAML.stringify(frontmatter) + '---\n\n' + post.content + '\n'
  const postPath = path.join(postDir, getPostFilename(post))

  fs.writeFile(postPath, data, (err) => {
    if (err) {
      console.log('Unable to write file.')
      console.log(err)
    } else {
      console.log('Wrote: ' + postPath)
    }
  })
}

function writeImageFile (imageUrl, imageDir, delay) {
  let imagePath = path.join(imageDir, getFilenameFromUrl(imageUrl))
  let stream = fs.createWriteStream(imagePath)
  stream.on('finish', () => {
    console.log('Saved: ' + imagePath)
  })
  // stagger image requests so we don't piss off hosts
  setTimeout(() => {
    request
      .get(encodeURI(imageUrl))
      .on('response', response => {
        if (response.statusCode !== 200) {
          console.log('Response status code ' + response.statusCode + ' received for ' + imageUrl + '.')
        }
      })
      .on('error', err => {
        console.log('Unable to download image.', imageUrl)
        console.log(err)
      })
      .pipe(stream)
  }, delay)
}

function getPostDir (post) {
  let dir = argv.output
  let dt = luxon.DateTime.fromISO(post.frontmatter.date)

  switch (argv.folders) {
    case 'year':
      dir = path.join(dir, dt.toFormat('yyyy'))
      break

    case 'yearmonth':
      dir = path.join(dir, dt.toFormat('yyyy'), dt.toFormat('LL'))
      break

    case 'path':
      dir = post.meta.status === 'draft'
        ? path.join(dir, 'drafts', post.meta.slug)
        : path.join(dir, post.meta.path)
      break

    case 'post':
      let folder = post.meta.slug
      if (argv.prefixdate) {
        folder = dt.toFormat('yyyy-LL-dd') + '-' + folder
      }
      dir = path.join(dir, folder)
      break
  }

  return dir
}

function getPostFilename (post) {
  const filename = post.meta.slug + '.md'

  // creating folders
  if (/path|post/.test(argv.folders)) {
    return argv.namedfiles
      ? filename
      : 'index.md'
  }

  // creating files
  if (argv.prefixdate) {
    const dt = luxon.DateTime.fromISO(post.frontmatter.date)
    return dt.toFormat('yyyy-LL-dd') + '-' + filename
  }
  return filename
}

// ---------------------------------------------------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------------------------------------------------

// meta options
const metaKeys = {
  // add transformer functions here
}

// object globals
let baseUrl
let images
let authors
let posts

// global so various functions can access arguments
let argv

function init () {
  argv = minimist(process.argv.slice(2), {
    string: [
      'input',
      'output',
      'folders'
    ],
    boolean: [
      'prefixdate',
      'namedfiles',
      'saveimages',
      'addcontentimages'
    ],
    default: {
      // I/O
      input: 'export.xml',
      output: 'output',
      filter: undefined,

      // files and folders
      folders: 'path',
      prefixdate: false,
      namedfiles: false,

      // content
      saveimages: true,
      addcontentimages: true
    }
  })

  // check folder option is valid
  const folders = 'year yearmonth path post'.split(' ')
  if (!folders.includes(argv.folders)) {
    console.error('Invalid `folders` option:', argv.folders)
    console.error('Choose from:', folders.join(', '))
    return
  }

  const content = readFile(argv.input)
  parseFileContent(content)
}

init()
