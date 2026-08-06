import { GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH } from './config.js'

const API_BASE = 'https://api.github.com'
const TOKEN_KEY = 'impi_gh_token'

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || ''
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token.trim())
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY)
}

function authHeaders() {
  return {
    Authorization: `Bearer ${getToken()}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  }
}

// ---- UTF-8 safe base64 helpers (GitHub stores file content as base64) ----

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function base64ToUtf8(base64) {
  const binary = atob(base64.replace(/\n/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

// ---- Public API ----

export async function verifyToken() {
  const res = await fetch(`${API_BASE}/repos/${GITHUB_OWNER}/${GITHUB_REPO}`, {
    headers: authHeaders()
  })
  if (!res.ok) {
    throw new Error(
      'Could not access the repository with this token. Check the token is valid, not expired, and has "Contents: Read and write" access to this repo.'
    )
  }
  return true
}

export async function fetchJsonFile(path) {
  const res = await fetch(
    `${API_BASE}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}?ref=${GITHUB_BRANCH}&t=${Date.now()}`,
    { headers: authHeaders() }
  )
  if (res.status === 404) {
    return { data: [], sha: null }
  }
  if (!res.ok) {
    throw new Error(`Could not load ${path} (status ${res.status})`)
  }
  const json = await res.json()
  const text = base64ToUtf8(json.content)
  return { data: JSON.parse(text), sha: json.sha }
}

export async function putJsonFile(path, dataObj, sha, message) {
  const content = utf8ToBase64(JSON.stringify(dataObj, null, 2))
  const res = await fetch(`${API_BASE}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: message || 'Update staff cards data',
      content,
      sha: sha || undefined,
      branch: GITHUB_BRANCH
    })
  })
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}))
    throw new Error(errBody.message || `Could not save ${path} (status ${res.status})`)
  }
  const json = await res.json()
  return json.content.sha
}

export async function uploadBinaryFile(path, file) {
  const arrayBuffer = await file.arrayBuffer()
  const bytes = new Uint8Array(arrayBuffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  const content = btoa(binary)

  const res = await fetch(`${API_BASE}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Upload ${path}`,
      content,
      branch: GITHUB_BRANCH
    })
  })
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}))
    throw new Error(errBody.message || `Upload failed (status ${res.status})`)
  }
  return path
}
