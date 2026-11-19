export function BrandIcon({ name }: { name: string }) {
  return (
    <svg className="line-icon brand-icon" viewBox="0 0 32 32" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {name === '咖啡' ? <>
        <path d="M5 13h19v7a9 9 0 0 1-18 0v-7Zm19 1h2a4 4 0 0 1 0 8h-2M5 30h20" />
        <path d="M10 3c3 3-3 4 0 7m6-9c3 3-3 5 0 8m6-6c3 3-3 4 0 7" />
      </> : name === '餐飲' ? <>
        <path d="M5 2v9a4 4 0 0 0 8 0V2M9 2v28m14-28c-5 5-6 10-6 16h6m0-16v28" />
      </> : <>
        <path d="M5 6h22v22H5zM11 6V3h10v3M11 13h10m-10 6h10" />
      </>}
    </svg>
  );
}

export function RefreshIcon() {
  return (
    <svg className="line-icon refresh-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M20 9a8 8 0 0 0-14-3L3 9m0-6v6h6M4 15a8 8 0 0 0 14 3l3-3m0 6v-6h-6" />
    </svg>
  );
}
