import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IsbnService } from './isbn.service';

describe('IsbnService', () => {
  const createService = (certKey?: string) => {
    const configService = {
      get: (key: string) => {
        if (key === 'SEOJI_CERT_KEY') return certKey;
        return undefined;
      },
    } as ConfigService;

    return new IsbnService(configService);
  };

  const seojiDoc = (overrides: Record<string, any> = {}) => ({
    TITLE_URL: 'https://www.nl.go.kr/seoji/fu/ecip/dbfiles/cover.jpg',
    TITLE: '책 제목',
    AUTHOR: '저자',
    PUBLISHER: '출판사',
    PUBLISH_PREDATE: '20230115',
    ...overrides,
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('SEOJI 응답을 명세 필드로 매핑해 반환한다', async () => {
    const service = createService('test-key');
    vi.spyOn(axios, 'get').mockResolvedValue({ data: { docs: [seojiDoc()] } });

    await expect(service.getBookInfo('9791190626187')).resolves.toEqual({
      isbn: '9791190626187',
      coverUrl: 'https://www.nl.go.kr/seoji/fu/ecip/dbfiles/cover.jpg',
      title: '책 제목',
      author: '저자',
      publisher: '출판사',
      publishYear: '2023',
    });
  });

  it('TITLE_URL이 빈 문자열이면 coverUrl을 null로 반환한다', async () => {
    const service = createService('test-key');
    vi.spyOn(axios, 'get').mockResolvedValue({
      data: { docs: [seojiDoc({ TITLE_URL: '' })] },
    });

    const result = await service.getBookInfo('9791190626187');
    expect(result.coverUrl).toBeNull();
    expect(result.title).toBe('책 제목');
  });

  it('검색 결과가 없으면 NotFoundException(ISBN not found)을 던진다', async () => {
    const service = createService('test-key');
    vi.spyOn(axios, 'get').mockResolvedValue({ data: { docs: [] } });

    await expect(service.getBookInfo('9791190626187')).rejects.toThrow(
      'ISBN not found',
    );
  });

  it('SEOJI가 ERR_CODE를 반환하면 BadGatewayException을 던진다', async () => {
    const service = createService('test-key');
    vi.spyOn(axios, 'get').mockResolvedValue({
      data: { ERR_CODE: '010', ERR_MESSAGE: '인증키가 유효하지 않습니다.' },
    });

    await expect(service.getBookInfo('9791190626187')).rejects.toThrow(
      'SEOJI API error: [010] 인증키가 유효하지 않습니다.',
    );
  });

  it('SEOJI 호출이 실패하면 BadGatewayException을 던진다', async () => {
    const service = createService('test-key');
    vi.spyOn(axios, 'get').mockRejectedValue(
      new Error('timeout of 8000ms exceeded'),
    );

    await expect(service.getBookInfo('9791190626187')).rejects.toThrow(
      'SEOJI API error: timeout of 8000ms exceeded',
    );
  });

  it('SEOJI_CERT_KEY가 없으면 ServiceUnavailableException을 던진다', async () => {
    const service = createService(undefined);
    const get = vi.spyOn(axios, 'get');

    await expect(service.getBookInfo('9791190626187')).rejects.toThrow(
      'SEOJI_CERT_KEY',
    );
    expect(get).not.toHaveBeenCalled();
  });
});
