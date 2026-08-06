// Uploaded photos/logos are stored as relative paths (e.g. "photos/xxx.jpg")
// under the /public folder in the repo, so they need the site's base path
// prefixed. Full external URLs (e.g. a company default logo hosted
// elsewhere) are passed through unchanged.
export function assetUrl(path) {
  if (!path) return ''
  if (/^https?:\/\//i.test(path)) return path
  return `${import.meta.env.BASE_URL}${path}`
}
