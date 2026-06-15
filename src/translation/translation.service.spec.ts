import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { TranslationService } from './translation.service';

describe('TranslationService', () => {
  const createService = () => {
    const configService = {
      get: (key: string) => {
        if (key === 'GEMINI_API_KEY') return 'test-key';
        if (key === 'GEMINI_TRANSLATION_MAX_CHARS') return '20';
        return undefined;
      },
    } as ConfigService;

    return new TranslationService(configService);
  };

  it('한글이 없는 영문은 Gemini 호출 없이 그대로 반환한다', async () => {
    const service = createService();
    const generateContent = vi.fn();
    (service as any).model = { generateContent };

    await expect(service.translateText('Already English')).resolves.toBe(
      'Already English',
    );
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('기사 필드를 영문 컬럼명으로 반환한다', async () => {
    const service = createService();
    vi.spyOn(service, 'translateFields').mockResolvedValue({
      title: 'English title',
      writer: 'Reporter Hong',
      content: 'English content',
    });

    await expect(
      service.translateArticle({
        title: '한글 제목',
        writer: '홍 기자',
        content: '한글 본문',
      }),
    ).resolves.toEqual({
      title_en: 'English title',
      writer_en: 'Reporter Hong',
      content_en: 'English content',
    });
  });

  it('문자열이 아닌 필드 값은 거부한다', async () => {
    const service = createService();

    await expect(
      service.translateFields({ title: 123 } as any),
    ).rejects.toThrow('fields.title 값은 문자열이어야 합니다.');
  });

  it('행정구역명은 Gemini 응답과 무관하게 표준 로마자 표기로 고정된다', async () => {
    const service = createService();

    (service as any).ai = {
      models: {
        // Gemini가 '옹진군'을 'Ungjin County'로 잘못 의역해도
        // 플레이스홀더(@@PLACE0@@)는 그대로 보존되어야 한다.
        generateContent: vi.fn().mockResolvedValue({
          text: '@@PLACE0@@ 소재 민통선 인근'.replace(
            '@@PLACE0@@ 소재 민통선 인근',
            'Near the CCL located in @@PLACE0@@',
          ),
        }),
      },
    };

    await expect(
      service.translateText('옹진군 소재 민통선 인근'),
    ).resolves.toBe('Near the CCL located in Ongjin-gun');
  });
});
