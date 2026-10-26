export const categories = {
  IMAGE: { extensions: 'jpg jpeg png gif bmp webp', maxMB: 10 },
  DOCUMENT: { extensions: 'pdf doc docx txt md zip rar 7z tar gz tgz bz2 xz zst', maxMB: 20 },
  VIDEO: { extensions: 'mp4 mov webm mkv avi', maxMB: 50 },
  EXCEL: { extensions: 'xls xlsx csv', maxMB: 20 },
  JSON: { extensions: 'json', maxMB: 10 },
  PROJECT_ATTACHMENT: {
    extensions:
      'pdf doc docx txt md xls xlsx csv json jpg jpeg png gif bmp webp zip rar 7z tar gz tgz bz2 xz zst mp4 mov webm mkv avi',
    maxMB: 50,
  },
  ANY: { extensions: 'pdf doc docx txt xls xlsx csv json jpg jpeg png gif bmp webp', maxMB: 50 },
} as const;
export type FileCategory = keyof typeof categories;
export const businesses = {
  BUSINESS_LICENSE: { dir: 'business-license', category: 'IMAGE', sensitive: true },
  ID_CARD: { dir: 'id-card', category: 'IMAGE', sensitive: true },
  ORG_LOGO: { dir: 'org-logo', category: 'IMAGE', sensitive: false },
  AVATAR: { dir: 'avatar', category: 'IMAGE', sensitive: false },
  IMAGE: { dir: 'image', category: 'IMAGE', sensitive: false },
  VIDEO: { dir: 'video', category: 'VIDEO', sensitive: true },
  DOCUMENT: { dir: 'document', category: 'DOCUMENT', sensitive: true },
  EXCEL: { dir: 'excel', category: 'EXCEL', sensitive: true },
  JSON: { dir: 'json', category: 'JSON', sensitive: true },
  PROJECT_ATTACHMENT: {
    dir: 'project-attachment',
    category: 'PROJECT_ATTACHMENT',
    sensitive: true,
  },
  ENTRANCE_EXAM_ATTACHMENT: {
    dir: 'entrance-exam-attachment',
    category: 'PROJECT_ATTACHMENT',
    sensitive: true,
  },
  MEMBER_PERFORMANCE_ATTACHMENT: {
    dir: 'member-performance',
    category: 'PROJECT_ATTACHMENT',
    sensitive: true,
  },
  COMMON: { dir: 'common', category: 'ANY', sensitive: false },
} as const satisfies Record<string, { dir: string; category: FileCategory; sensitive: boolean }>;
export type FileBizType = keyof typeof businesses;
export interface FileUploadResponse {
  fileId: string;
  objectKey: string;
  uploadToken: string;
  url: string | null;
  sensitive: boolean;
  fileName: string;
  extension: string;
  size: number;
  contentType: string;
  fileHash: string;
}
