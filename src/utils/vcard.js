import { COMPANY_NAME, COMPANY_WEBSITE } from '../config.js'
import { assetUrl } from './assetUrl.js'

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      // reader.result looks like "data:image/jpeg;base64,AAAA..."
      const base64 = reader.result.split(',')[1]
      resolve(base64)
    }
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

function escapeVCard(value = '') {
  return String(value).replace(/([,;])/g, '\\$1').replace(/\n/g, '\\n')
}

async function buildVCardText(card) {
  const nameParts = (card.full_name || '').trim().split(/\s+/)
  const surname = nameParts.length > 1 ? nameParts.pop() : ''
  const firstNames = nameParts.join(' ')

  let photoLine = ''
  if (card.photo_url) {
    try {
      const res = await fetch(assetUrl(card.photo_url))
      const blob = await res.blob()
      const base64 = await blobToBase64(blob)
      const type = blob.type.includes('png') ? 'PNG' : 'JPEG'
      photoLine = `PHOTO;ENCODING=b;TYPE=${type}:${base64}`
    } catch (e) {
      console.warn('Could not embed photo in vCard, continuing without it.', e)
    }
  }

  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `N:${escapeVCard(surname)};${escapeVCard(firstNames)};;;`,
    `FN:${escapeVCard(card.full_name)}`,
    `ORG:${escapeVCard(COMPANY_NAME)}`,
    card.role_title ? `TITLE:${escapeVCard(card.role_title)}` : '',
    card.phone ? `TEL;TYPE=CELL,VOICE:${escapeVCard(card.phone)}` : '',
    card.email ? `EMAIL;TYPE=WORK:${escapeVCard(card.email)}` : '',
    card.address ? `ADR;TYPE=WORK:;;${escapeVCard(card.address)};;;;` : '',
    `URL:https://${COMPANY_WEBSITE}`,
    photoLine,
    'END:VCARD'
  ].filter(Boolean)

  return lines.join('\r\n')
}

export async function downloadVCard(card) {
  const vcf = await buildVCardText(card)
  const blob = new Blob([vcf], { type: 'text/vcard;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${(card.full_name || 'contact').replace(/\s+/g, '_')}.vcf`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
