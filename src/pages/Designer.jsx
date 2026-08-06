import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import {
  getToken,
  clearToken,
  verifyToken,
  fetchJsonFile,
  putJsonFile,
  uploadBinaryFile
} from '../githubClient.js'
import { slugify } from '../utils/slugify.js'
import { downloadCardAsPng } from '../utils/downloadCardImage.js'
import { BRAND } from '../config.js'
import GitHubTokenGate from './GitHubTokenGate.jsx'
import CardPreview from '../components/CardPreview.jsx'

const DATA_PATH = 'src/data/cards.json'

const emptyForm = {
  id: null,
  full_name: '',
  role_title: '',
  phone: '',
  email: '',
  address: '',
  slug: '',
  photo_url: '',
  logo_url: '',
  accent_color: BRAND.accent,
  dark_color: BRAND.dark,
  is_active: true
}

export default function Designer() {
  const [unlocked, setUnlocked] = useState(undefined) // undefined = checking
  const [cards, setCards] = useState([])
  const [loadingCards, setLoadingCards] = useState(true)
  const [form, setForm] = useState(emptyForm)
  const [slugTouched, setSlugTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [uploadingPhoto, setUploadingPhoto] = useState(false)
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const [error, setError] = useState('')
  const [statusMsg, setStatusMsg] = useState('')
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [copied, setCopied] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const cardRef = useRef(null)

  useEffect(() => {
    async function checkAuth() {
      if (!getToken()) {
        setUnlocked(false)
        return
      }
      try {
        await verifyToken()
        setUnlocked(true)
      } catch {
        clearToken()
        setUnlocked(false)
      }
    }
    checkAuth()
  }, [])

  useEffect(() => {
    if (unlocked) loadCards()
  }, [unlocked])

  useEffect(() => {
    let cancelled = false
    async function genQr() {
      if (!form.slug) {
        setQrDataUrl('')
        return
      }
      const url = `${window.location.origin}${window.location.pathname}#/card/${form.slug}`
      const qr = await QRCode.toDataURL(url, {
        margin: 1,
        width: 480,
        color: { dark: form.dark_color || '#231F20', light: '#FFFFFFFF' }
      })
      if (!cancelled) setQrDataUrl(qr)
    }
    genQr()
    return () => {
      cancelled = true
    }
  }, [form.slug, form.dark_color])

  async function loadCards() {
    setLoadingCards(true)
    setError('')
    try {
      const { data } = await fetchJsonFile(DATA_PATH)
      setCards(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoadingCards(false)
    }
  }

  function selectCard(card) {
    setForm(card)
    setSlugTouched(true)
    setError('')
    setStatusMsg('')
  }

  function startNewCard() {
    setForm({ ...emptyForm, id: `local-${Date.now()}` })
    setSlugTouched(false)
    setError('')
    setStatusMsg('')
  }

  function updateField(field, value) {
    setForm((prev) => {
      const next = { ...prev, [field]: value }
      if (field === 'full_name' && !slugTouched) {
        next.slug = slugify(value)
      }
      return next
    })
  }

  async function handlePhotoChange(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadingPhoto(true)
    setError('')
    try {
      const ext = file.name.split('.').pop()
      const path = `photos/${Date.now()}-${slugify(file.name.replace(/\.[^.]+$/, ''))}.${ext}`
      await uploadBinaryFile(`public/${path}`, file)
      updateField('photo_url', path)
    } catch (err) {
      setError(`Photo upload failed: ${err.message}`)
    } finally {
      setUploadingPhoto(false)
    }
  }

  async function handleLogoChange(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadingLogo(true)
    setError('')
    try {
      const ext = file.name.split('.').pop()
      const path = `logos/${Date.now()}-${slugify(file.name.replace(/\.[^.]+$/, ''))}.${ext}`
      await uploadBinaryFile(`public/${path}`, file)
      updateField('logo_url', path)
    } catch (err) {
      setError(`Logo upload failed: ${err.message}`)
    } finally {
      setUploadingLogo(false)
    }
  }

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    setStatusMsg('')

    try {
      // Re-fetch the latest file right before saving, so we always write
      // against the current version (avoids overwriting someone else's
      // edit if two people save close together).
      const { data: latest, sha: latestSha } = await fetchJsonFile(DATA_PATH)

      const payload = { ...form, slug: slugify(form.slug || form.full_name) }
      const isNew = !latest.some((c) => c.id === payload.id)

      let updated
      if (isNew) {
        payload.id =
          !payload.id || payload.id.toString().startsWith('local-')
            ? crypto.randomUUID()
            : payload.id
        updated = [...latest, payload]
      } else {
        updated = latest.map((c) => (c.id === payload.id ? payload : c))
      }

      await putJsonFile(
        DATA_PATH,
        updated,
        latestSha,
        `${isNew ? 'Add' : 'Update'} card: ${payload.full_name}`
      )

      setCards(updated)
      setForm(payload)
      setSlugTouched(true)
      setStatusMsg('Saved — live on the public site within a minute or two.')
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function toggleActive(card) {
    setError('')
    try {
      const { data: latest, sha: latestSha } = await fetchJsonFile(DATA_PATH)
      const updated = latest.map((c) =>
        c.id === card.id ? { ...c, is_active: !c.is_active } : c
      )
      await putJsonFile(DATA_PATH, updated, latestSha, `Toggle active: ${card.full_name}`)
      setCards(updated)
      if (form.id === card.id) updateField('is_active', !card.is_active)
    } catch (err) {
      setError(err.message)
    }
  }

  async function deleteCard(card) {
    if (!window.confirm(`Permanently delete ${card.full_name}'s card? This cannot be undone.`)) {
      return
    }
    setError('')
    try {
      const { data: latest, sha: latestSha } = await fetchJsonFile(DATA_PATH)
      const updated = latest.filter((c) => c.id !== card.id)
      await putJsonFile(DATA_PATH, updated, latestSha, `Delete card: ${card.full_name}`)
      setCards(updated)
      if (form.id === card.id) startNewCard()
    } catch (err) {
      setError(err.message)
    }
  }

  function cardUrl(slug) {
    return `${window.location.origin}${window.location.pathname}#/card/${slug}`
  }

  function copyLink() {
    if (!form.slug) return
    navigator.clipboard.writeText(cardUrl(form.slug))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  async function handleDownloadImage() {
    setDownloading(true)
    try {
      await downloadCardAsPng(
        cardRef.current,
        `${slugify(form.full_name || 'business-card')}-business-card.png`
      )
    } catch (err) {
      console.error('Could not generate card image', err)
      setError('Sorry, the card image could not be generated. Please try again.')
    } finally {
      setDownloading(false)
    }
  }

  function handleSignOut() {
    clearToken()
    setUnlocked(false)
  }

  if (unlocked === undefined) return <div className="admin-shell">Checking access…</div>
  if (unlocked === false) return <GitHubTokenGate onUnlocked={() => setUnlocked(true)} />

  return (
    <div className="designer-shell">
      <div className="designer-topbar">
        <h1 className="admin-title">IMPI Digital Cards — Designer</h1>
        <button className="admin-btn-secondary" onClick={handleSignOut}>
          Sign out
        </button>
      </div>

      <div className="designer-body">
        <aside className="designer-sidebar">
          <button className="admin-btn-primary designer-new-btn" onClick={startNewCard}>
            + New card
          </button>

          {loadingCards ? (
            <div className="designer-sidebar-empty">Loading…</div>
          ) : cards.length === 0 ? (
            <div className="designer-sidebar-empty">No cards yet.</div>
          ) : (
            <div className="designer-list">
              {cards.map((card) => (
                <button
                  key={card.id}
                  className={`designer-list-item ${form.id === card.id ? 'selected' : ''}`}
                  onClick={() => selectCard(card)}
                >
                  <span className="designer-list-name">{card.full_name}</span>
                  <span className="designer-list-role">{card.role_title}</span>
                  <span className={`admin-badge ${card.is_active ? 'active' : 'inactive'}`}>
                    {card.is_active ? 'Active' : 'Inactive'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </aside>

        <main className="designer-main">
          <form onSubmit={handleSave} className="designer-form">
            <label className="admin-field">
              <span>Full name</span>
              <input
                required
                value={form.full_name}
                onChange={(e) => updateField('full_name', e.target.value)}
                placeholder="Shane Steynfaardt"
              />
            </label>

            <label className="admin-field">
              <span>Role / job title</span>
              <input
                required
                value={form.role_title}
                onChange={(e) => updateField('role_title', e.target.value)}
                placeholder="Senior Operations Manager"
              />
            </label>

            <div className="admin-field-row">
              <label className="admin-field">
                <span>Phone</span>
                <input
                  value={form.phone || ''}
                  onChange={(e) => updateField('phone', e.target.value)}
                  placeholder="083 782 2207"
                />
              </label>
              <label className="admin-field">
                <span>Email</span>
                <input
                  type="email"
                  value={form.email || ''}
                  onChange={(e) => updateField('email', e.target.value)}
                  placeholder="shane@impi-secure.co.za"
                />
              </label>
            </div>

            <label className="admin-field">
              <span>Address (optional)</span>
              <input
                value={form.address || ''}
                onChange={(e) => updateField('address', e.target.value)}
                placeholder="10 Kosmos Crescent, Rynoue AH, Pretoria"
              />
            </label>

            <label className="admin-field">
              <span>Card link (slug)</span>
              <input
                value={form.slug}
                onChange={(e) => {
                  setSlugTouched(true)
                  updateField('slug', slugify(e.target.value))
                }}
                placeholder="shane-steynfaardt"
              />
              <small>{form.slug ? cardUrl(form.slug) : 'Set a name to generate a link'}</small>
            </label>

            <div className="admin-field-row">
              <div className="admin-field">
                <span>Photo</span>
                {form.photo_url && (
                  <img
                    src={`${import.meta.env.BASE_URL}${form.photo_url}`}
                    alt="Preview"
                    className="admin-preview-photo"
                  />
                )}
                <input type="file" accept="image/*" onChange={handlePhotoChange} />
                {uploadingPhoto && <small>Uploading…</small>}
              </div>

              <div className="admin-field">
                <span>Logo (blank = company default)</span>
                {form.logo_url && (
                  <img
                    src={`${import.meta.env.BASE_URL}${form.logo_url}`}
                    alt="Logo preview"
                    className="admin-preview-logo"
                  />
                )}
                <input type="file" accept="image/*" onChange={handleLogoChange} />
                {uploadingLogo && <small>Uploading…</small>}
              </div>
            </div>

            <div className="admin-field-row">
              <label className="admin-field">
                <span>Accent colour</span>
                <input
                  type="color"
                  value={form.accent_color}
                  onChange={(e) => updateField('accent_color', e.target.value)}
                />
              </label>
              <label className="admin-field">
                <span>Text colour</span>
                <input
                  type="color"
                  value={form.dark_color}
                  onChange={(e) => updateField('dark_color', e.target.value)}
                />
              </label>
              <label className="admin-checkbox designer-active-checkbox">
                <input
                  type="checkbox"
                  checked={form.is_active}
                  onChange={(e) => updateField('is_active', e.target.checked)}
                />
                <span>Active</span>
              </label>
            </div>

            {error && <div className="admin-error">{error}</div>}
            {statusMsg && <div className="admin-notice designer-notice">{statusMsg}</div>}

            <div className="admin-form-actions">
              <button type="submit" className="admin-btn-primary" disabled={saving}>
                {saving
                  ? 'Saving…'
                  : form.id && !form.id.toString().startsWith('local-')
                  ? 'Save changes'
                  : 'Create card'}
              </button>
              {form.slug && (
                <button type="button" className="admin-btn-secondary" onClick={copyLink}>
                  {copied ? 'Copied!' : 'Copy link'}
                </button>
              )}
              {form.id && !form.id.toString().startsWith('local-') && (
                <>
                  <button
                    type="button"
                    className="admin-btn-secondary"
                    onClick={() => toggleActive(form)}
                  >
                    {form.is_active ? 'Deactivate' : 'Activate'}
                  </button>
                  <button
                    type="button"
                    className="admin-btn-danger"
                    onClick={() => deleteCard(form)}
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
          </form>

          <div className="designer-preview">
            <div className="designer-preview-label">Live preview</div>
            <div className="designer-preview-frame">
              <CardPreview
                ref={cardRef}
                card={form}
                qrDataUrl={qrDataUrl}
                onDownloadImage={form.slug ? handleDownloadImage : undefined}
                downloading={downloading}
              />
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
