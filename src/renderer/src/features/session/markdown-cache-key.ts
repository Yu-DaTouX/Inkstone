export function markdownCacheKey(options: { lang: string; allowHtml: boolean; math: boolean; text: string }): string {
  return JSON.stringify([options.lang, options.allowHtml, options.math, options.text])
}
