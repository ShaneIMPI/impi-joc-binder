import { Routes, Route, Navigate } from 'react-router-dom'
import CardView from './pages/CardView.jsx'
import Designer from './pages/Designer.jsx'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/admin" replace />} />
      <Route path="/card/:slug" element={<CardView />} />
      <Route path="/admin" element={<Designer />} />
      <Route path="*" element={<Navigate to="/admin" replace />} />
    </Routes>
  )
}
