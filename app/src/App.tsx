import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import MeetingListPage from './components/MeetingListPage'
import MeetingDetailPage from './components/MeetingDetailPage'

export default function App() {
  return (
    <BrowserRouter>
      <div className="app-shell">
        <header className="app-header">
          <h1 className="app-title">
            <a href="/meetings" style={{ color: 'inherit', textDecoration: 'none' }}>CcAsr</a>
          </h1>
          <span className="app-subtitle">会议录音 → 转录 → 纪要</span>
        </header>
        <main className="app-main">
          <Routes>
            <Route path="/" element={<Navigate to="/meetings" replace />} />
            <Route path="/meetings" element={<MeetingListPage />} />
            <Route path="/meeting/:projectId" element={<MeetingDetailPage />} />
            <Route path="*" element={
              <div style={{ textAlign: 'center', padding: 60, color: '#999' }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>🔍</div>
                <p>页面不存在</p>
                <a href="/meetings" style={{ color: '#4361ee' }}>返回我的会议</a>
              </div>
            } />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}
