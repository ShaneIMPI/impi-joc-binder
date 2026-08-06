import { toPng } from 'html-to-image'

// Renders a DOM node (the card) to a PNG and triggers a download.
// Uses a higher pixel ratio so it stays crisp enough for print.
export async function downloadCardAsPng(node, fileName) {
  if (!node) throw new Error('Card element not found.')

  const dataUrl = await toPng(node, {
    pixelRatio: 3,
    cacheBust: true,
    backgroundColor: '#ffffff'
  })

  const a = document.createElement('a')
  a.href = dataUrl
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}
