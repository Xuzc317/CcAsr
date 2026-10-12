import { useId } from 'react';

/**
 * CcAsr 品牌标记 ——「声波，落成文字」。
 *
 * 左侧 4 根振幅渐次收束的声波竖条，旋转 90° 收敛为右侧 3 行文字横线，
 * 把「语音 → 文本」这个产品本质画进标识里，也与转录页
 * 「时间戳 + 文本行」的版式同构。
 *
 * 用 React 组件（而非 <img>）渲染，是为了：
 *   - 转录/生成中可以让 7 根线条按振幅依次起伏（.logo-wave）
 *   - 渐变 id 用 useId 保证同页多个实例不冲突
 */

interface Props {
  /** 边长（正方形） */
  size?: number;
  /** 波浪动画：用于加载 / 转录中 / 生成中 */
  animated?: boolean;
  /** 无背景的纯线条稿（极浅底或已着色底上使用） */
  flat?: boolean;
  className?: string;
  title?: string;
}

export default function Logo({
  size = 24, animated = false, flat = false, className, title,
}: Props) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const gradId = `ccasr-g-${uid}`;
  const round = Math.round((size / 96) * 24);

  return (
    <svg
      className={['logo-mark', animated ? 'logo-wave' : '', className]
        .filter(Boolean).join(' ')}
      width={size}
      height={size}
      viewBox="0 0 96 96"
      role="img"
      aria-label={title ?? 'CcAsr'}
      focusable="false"
    >
      {!flat && (
        <>
          <defs>
            {/* 品牌渐变的两个色标是**品牌资产**的一部分（与 docs/design/logo.svg
                和 favicon.svg 逐位一致），因此是唯一允许写死色值的地方：
                改了这里，图标与图形标识就会对不上。 */}
            <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#4F46E5" />
              <stop offset="1" stopColor="#8B5CF6" />
            </linearGradient>
          </defs>
          <rect width="96" height="96" rx={round} fill={`url(#${gradId})`} />
        </>
      )}
      <g
        stroke={flat ? 'var(--brand)' : '#FFFFFF'}
        strokeWidth="5.5"
        strokeLinecap="round"
        fill="none"
      >
        <line x1="22" y1="41" x2="22" y2="55" />
        <line x1="32" y1="34" x2="32" y2="62" />
        <line x1="42" y1="27" x2="42" y2="69" />
        <line x1="52" y1="38" x2="52" y2="58" opacity="0.9" />
        <line x1="62" y1="36" x2="78" y2="36" />
        <line x1="62" y1="48" x2="73" y2="48" opacity="0.9" />
        <line x1="62" y1="60" x2="79" y2="60" />
      </g>
    </svg>
  );
}

/**
 * 顶栏横排组合：图标 + 「CcAsr」字标。
 * 单一品牌语言 —— 顶栏、favicon、空态、加载动画共用同一个标记。
 */
export function BrandLockup({ subtitle }: { subtitle?: string }) {
  return (
    <a className="app-brand" href="/meetings">
      <Logo size={24} />
      <span className="brandname">Cc<em>Asr</em></span>
      {subtitle && <span className="app-subtitle">{subtitle}</span>}
    </a>
  );
}
