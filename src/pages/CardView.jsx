import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import QRCode from 'qrcode'
import cardsData from '../data/cards.json'
import { downloadVCard } from '../utils/vcard.js'
import { downloadCardAsPng } from '../utils/downloadCardImage.js'
import { slugify } from '../utils/slugify.js'
import CardPreview from '../components/CardPreview.jsx'

export default function CardView() {
  const { slug } = useParams()
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const cardRef = useRef(null)

  const card = cardsData.find((c) => c.slug === slug && c.is_active !== false)

  useEffect(() => {
    if (!card) return
    let cancelled = false
    QRCode.toDataURL(window.location.href, {
      margin: 1,
      width: 480,
      color: { dark: card.dark_color || '#231F20', light: '#FFFFFFFF' }
    }).then((qr) => {
      if (!cancelled) setQrDataUrl(qr)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug])

  if (!card) {
    return (
      <div className="card-loading">
        This card could not be found, or is no longer active.
      </div>
    )
  }

  async function handleSave() {
    setSaving(true)
    try {
      await downloadVCard(card)
    } finally {
      setSaving(false)
    }
  }

  async function handleDownloadImage() {
    setDownloading(true)
    try {
      await downloadCardAsPng(cardRef.current, `${slugify(card.full_name)}-business-card.png`)
    } catch (err) {
      console.error('Could not generate card image', err)
      alert('Sorry, the card image could not be generated. Please try again.')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <CardPreview
      ref={cardRef}
      card={card}
      qrDataUrl={qrDataUrl}
      onSaveContact={handleSave}
      saving={saving}
      onDownloadImage={handleDownloadImage}
      downloading={downloading}
    />
  )
}
