import { useState } from 'react'
import { setToken, clearToken, verifyToken } from '../githubClient.js'

export default function GitHubTokenGate({ onUnlocked }) {
  const [token, setTokenInput] = useState('')
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setChecking(true)
    setError('')
    setToken(token)
    try {
      await verifyToken()
      onUnlocked()
    } catch (err) {
      clearToken()
      setError(err.message)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="admin-shell">
      <div className="admin-login-box">
        <h1 className="admin-title">IMPI Digital Cards — Designer access</h1>
        <p className="admin-subtitle">
          Paste your GitHub access token to unlock editing. See <code>SETUP.md</code> in the
          project for how to create one (one-time setup, takes two minutes).
        </p>
        <form onSubmit={handleSubmit} className="admin-form">
          <label className="admin-field">
            <span>GitHub access token</span>
            <input
              type="password"
              required
              autoComplete="off"
              value={token}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="github_pat_..."
            />
          </label>
          {error && <div className="admin-error">{error}</div>}
          <button type="submit" className="admin-btn-primary" disabled={checking}>
            {checking ? 'Checking…' : 'Unlock designer'}
          </button>
          <small>
            This is stored only in this browser. It's never sent anywhere except directly to
            GitHub.
          </small>
        </form>
      </div>
    </div>
  )
}
