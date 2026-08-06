import { forwardRef } from 'react'
import { DEFAULT_LOGO_URL, COMPANY_NAME, COMPANY_WEBSITE, COMPANY_PHONE } from '../config.js'
import { assetUrl } from '../utils/assetUrl.js'

const CardPreview = forwardRef(function CardPreview(
  { card, qrDataUrl, onSaveContact, saving, onDownloadImage, downloading },
  ref
) {
  const accent = card.accent_color || '#B8942E'
  const dark = card.dark_color || '#231F20'
  const logo = assetUrl(card.logo_url || DEFAULT_LOGO_URL)
  const photo = assetUrl(card.photo_url)

  return (
    <div className="card-page" style={{ '--accent': accent, '--dark': dark }} ref={ref}>
      <div className="card-header">
        {logo ? (
          <img src={logo} alt="Company logo" className="card-logo" crossOrigin="anonymous" />
        ) : (
          <div className="card-logo-fallback">IMPI</div>
        )}
        <span className="card-company">{COMPANY_NAME}</span>
      </div>

      <div className="card-main">
        <div className="card-identity">
          <div className="card-role">{card.role_title || 'Job title'}</div>
          <h1 className="card-name">{card.full_name || 'Full name'}</h1>
        </div>
        {photo && (
          <img src={photo} alt={card.full_name} className="card-photo" crossOrigin="anonymous" />
        )}
      </div>

      <div className="card-contact-row">
        {card.phone && (
          <div>
            <div className="card-label">Phone</div>
            <div className="card-value">{card.phone}</div>
          </div>
        )}
        {card.email && (
          <div className="card-contact-right">
            <div className="card-label">Email</div>
            <div className="card-value card-value-email">{card.email}</div>
          </div>
        )}
      </div>

      {card.address && (
        <div className="card-address-block">
          <div className="card-label">Address</div>
          <div className="card-value">{card.address}</div>
        </div>
      )}

      {(onSaveContact || onDownloadImage) && (
        <div className="card-action-row" data-html2canvas-ignore={onSaveContact ? undefined : 'true'}>
          {onSaveContact && (
            <button className="card-save-btn" onClick={onSaveContact} disabled={saving}>
              {saving ? 'Preparing…' : '+ Save to Contacts'}
            </button>
          )}
          {onDownloadImage && (
            <button className="card-download-btn" onClick={onDownloadImage} disabled={downloading}>
              {downloading ? 'Preparing…' : 'Download card (PNG)'}
            </button>
          )}
        </div>
      )}

      {qrDataUrl && (
        <div className="card-qr">
          <img src={qrDataUrl} alt="QR code linking to this card" />
          <div className="card-qr-caption">Scan to open this card</div>
        </div>
      )}

      <div className="card-footer">
        {COMPANY_WEBSITE} · {COMPANY_PHONE}
      </div>
    </div>
  )
})

export default CardPreview
