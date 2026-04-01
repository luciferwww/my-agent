/** 媒体附件类型 */
export type MediaType = 'image' | 'file';

/** 图像附件（base64 编码） */
export interface ImageAttachment {
  type: 'image';
  /** base64 编码的图像内容 */
  data: string;
  /** MIME 类型，如 'image/jpeg'、'image/png' */
  mimeType: string;
  /** 可选的用户说明文字 */
  caption?: string;
}

/** 文件附件 */
export interface FileAttachment {
  type: 'file';
  /** 文件名 */
  filename: string;
  /** 文件内容 */
  content: string;
  /** MIME 类型 */
  mimeType: string;
  /** 可选的用户说明文字 */
  caption?: string;
}

/** 联合类型：所有支持的媒体附件 */
export type MediaAttachment = ImageAttachment | FileAttachment;
