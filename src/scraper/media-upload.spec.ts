import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { ScraperConfigController } from './scraper.config.controller';

// ─── POST /scraper/media/upload (CMS → S3 업로드 관문) ────────────────────────

const putMediaObject = vi.fn();
const s3Stub = { putMediaObject } as any;

// 업로드 관문만 검증 — 나머지 생성자 의존성은 사용되지 않으므로 빈 스텁
const controller = new ScraperConfigController(
  {} as any,
  {} as any,
  {} as any,
  {} as any,
  {} as any,
  {} as any,
  {} as any,
  s3Stub,
);

const file = (buffer = Buffer.from('pdf-bytes'), mimetype = 'application/pdf') =>
  ({ originalname: 'a.pdf', mimetype, size: buffer.length, buffer }) as any;

const resStub = () => {
  const res: any = { statusCode: 0, body: null };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: any) => {
    res.body = body;
    return res;
  });
  return res;
};

beforeEach(() => {
  putMediaObject.mockReset();
  putMediaObject.mockImplementation(async (key: string, body: Buffer) => ({
    bucket: 'dmz-portal-bucket',
    key,
    etag: '"abc123"',
    size: body.length,
  }));
});

describe('uploadMedia', () => {
  it('허용 prefix면 받은 key 그대로 putObject하고 { success, key, etag }를 내려준다', async () => {
    const res = resStub();
    await controller.uploadMedia(file(), 'archive/ab12cd34.pdf', res);

    expect(putMediaObject).toHaveBeenCalledWith(
      'archive/ab12cd34.pdf',
      expect.any(Buffer),
      'application/pdf',
    );
    expect(res.statusCode).toBe(200);
    // 전역 인터셉터 래핑({success,data,timestamp}) 없이 명세 그대로여야 한다
    expect(res.body).toEqual({ success: true, key: 'archive/ab12cd34.pdf', etag: '"abc123"' });
  });

  it('CMS가 file_path 형태로 앞 /를 붙여 보내도 정규화해서 올린다', async () => {
    await controller.uploadMedia(file(), '/law/9f8e.hwp', resStub());
    expect(putMediaObject.mock.calls[0][0]).toBe('law/9f8e.hwp');
  });

  it.each([
    ['빈 key', ''],
    ['허용 외 prefix', 'news-crawler/x.pdf'],
    ['prefix만 있고 파일명 없음', 'archive'],
    ['상위 경로 탈출', 'archive/../law/x.pdf'],
    ['빈 세그먼트', 'archive//x.pdf'],
    ['백슬래시', 'archive\\x.pdf'],
  ])('잘못된 key(%s)는 400이고 S3를 건드리지 않는다', async (_label, key) => {
    await expect(controller.uploadMedia(file(), key, resStub())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(putMediaObject).not.toHaveBeenCalled();
  });

  it('file 파트가 없거나 비어 있으면 400', async () => {
    await expect(
      controller.uploadMedia(undefined as any, 'archive/x.pdf', resStub()),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.uploadMedia(file(Buffer.alloc(0)), 'archive/x.pdf', resStub()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('S3 실패는 500으로 매핑한다 (CMS는 best-effort라 WARN만 남기고 진행)', async () => {
    putMediaObject.mockRejectedValueOnce(new Error('AccessDenied'));
    await expect(
      controller.uploadMedia(file(), 'archive/x.pdf', resStub()),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});
