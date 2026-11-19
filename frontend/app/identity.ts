export const roleLabels = {
  MEMBER: '會員',
  GROUP_ADMIN: '集團管理員',
  BRAND_ADMIN: '品牌管理員',
} as const;

// 身分 DTO 僅包含登入介面的傳輸欄位；品牌與會員資源仍由各用例驗證授權。
export type IdentityDto = {
  username: string;
  displayName: string;
  role: keyof typeof roleLabels;
  memberNumber: string | null;
};

export function isIdentityDto(body: unknown): body is IdentityDto {
  if (!body || typeof body !== 'object') return false;
  const { username, displayName, role, memberNumber } = body as Partial<IdentityDto>;
  return typeof username === 'string' && typeof displayName === 'string'
    && typeof role === 'string' && Object.hasOwn(roleLabels, role)
    && (role === 'MEMBER' ? typeof memberNumber === 'string' : memberNumber === null);
}
