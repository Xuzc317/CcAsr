import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import MeetingListPage from './components/MeetingListPage';
import MeetingDetailPage from './components/MeetingDetailPage';
import { BrandLockup } from './components/Logo';

export default function App() {
  return (
    <BrowserRouter>
      <div className="app-shell">
        {/* 浅色细顶栏：全案最高频的噪音源（深蓝底 + 红色文字标）已移除，
            视觉重心还给内容；顶栏与 favicon 共用同一个品牌标记。 */}
        <header className="app-header">
          <BrandLockup subtitle="会议录音 → 转录 → 纪要" />
        </header>
        <main className="app-main">
          <Routes>
            <Route path="/" element={<Navigate to="/meetings" replace />} />
            <Route path="/meetings" element={<MeetingListPage />} />
            <Route path="/meeting/:projectId" element={<MeetingDetailPage />} />
            <Route path="*" element={
              <div className="empty" style={{ paddingTop: 96 }}>
                <div style={{ fontSize: 40, lineHeight: 1 }}>🔍</div>
                <div className="empty-title">页面不存在</div>
                <div className="empty-actions">
                  <a className="btn btn-secondary" href="/meetings">返回我的会议</a>
                </div>
              </div>
            } />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
