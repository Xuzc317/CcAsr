import { BrowserRouter, Routes, Route } from 'react-router-dom'
import TaskListPage from './components/TaskListPage'
import UploadPage from './components/UploadPage'
import WorkspacePage from './components/WorkspacePage'

export default function App() {
  return (
    <BrowserRouter>
      <div className="app-shell">
        <header className="app-header">
          <h1 className="app-title"><a href="/tasks" style={{ color: 'inherit', textDecoration: 'none' }}>CcAsr</a></h1>
          <span className="app-subtitle">Audio Transcription &amp; Editor</span>
        </header>
        <main className="app-main">
          <Routes>
            <Route path="/" element={<TaskListPage />} />
            <Route path="/tasks" element={<TaskListPage />} />
            <Route path="/upload" element={<UploadPage />} />
            <Route path="/task/:taskId" element={<WorkspacePage />} />
            <Route path="*" element={
              <div style={{ textAlign: 'center', padding: 60, color: '#999' }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>🔍</div>
                <p>页面不存在</p>
                <a href="/" style={{ color: '#4361ee' }}>返回首页</a>
              </div>
            } />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}
