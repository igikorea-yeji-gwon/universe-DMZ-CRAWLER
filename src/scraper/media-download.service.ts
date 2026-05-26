import { Injectable, Logger } from '@nestjs/common';
import { Page } from 'playwright';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createWriteStream } from 'fs';
import { Readable } from 'stream';
import type { ReadableStream as WebReadableStream } from 'stream/web';
import { S3Service } from 'src/aws/s3/s3.service';
import { GoogleChatService } from 'src/common/webhook/google-chat.service';

@Injectable()
export class MediaDownloadService {
  private readonly logger = new Logger(MediaDownloadService.name);

  constructor(
    private readonly s3Service: S3Service,
    private readonly googleChatService: GoogleChatService,
  ) {}

  /**
   * 페이지에서 이미지를 추출하고 S3에 업로드한다.
   * 각 이미지에 대해 캡션을 추출하고, Gemini AI로 시각적 콘텐츠 여부를 분석한다.
   * 브라우저 세션의 쿠키/인증 정보를 사용하여 보호된 이미지도 다운로드할 수 있다.
   * SVG 이미지는 건너뛴다.
   */
  async handleImagesStep(page: Page, target: any, configId: number, webhook = true) {
    const { selector, captionSelector, containerSelector } = target;
    // 1) selector에 해당하는 모든 이미지 URL 및 캡션 추출
    const items = await page.$$eval(
      selector,
      (els, { containerSel, capSel }) =>
        els.map((el) => {
          const url = (el as HTMLImageElement).src;
          let capEl: Element | null = null;
          if (containerSel && capSel) {
            capEl = el.closest(containerSel)?.querySelector(capSel) || null;
          }
          // 만약 containerSel/capSel 이 없으면, caption 비우기
          const caption = capEl?.textContent?.trim() ?? '';
          return { url, caption };
        }),
      { containerSel: containerSelector, capSel: captionSelector },
    );

    // 2) 현재 페이지 세션의 쿠키를 문자열 형태로 변환
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    // 개별 이미지 다운로드 → 임시 저장 → S3 업로드
    const results: any[] = [];
    for (let i = 0; i < items.length; i++) {
      const { url, caption } = items[i];
      // 1) 절대 URL 변환
      const imgUrl = new URL(url, page.url()).href;

      // 2) 요청 및 상태 체크
      const requestContext = page.context().request;

      const headers: Record<string, string> = {
        // 현재 페이지를 Referer로 설정
        Referer: page.url(),
        Origin: new URL(page.url()).origin,
        // 현재 브라우저와 동일한 User-Agent를 강제로 설정
        'User-Agent': await page.evaluate(() => navigator.userAgent),
      };
      // 쿠키 문자열 추가 (인증 쿠키가 필요할 때)
      if (cookieHeader) headers.Cookie = cookieHeader;

      let res;
      try {
        res = await requestContext.get(imgUrl, { headers }).catch();
        if (!res.ok()) {
          console.error(
            `🔥 HTTP Error ${res.status()}: ${res.statusText()} for ${imgUrl}`,
          );
          continue;
        }
      } catch (err) {
        console.error(`🚨 Request failed for ${imgUrl}:`, err);
        continue;
      }
      if (!res.ok()) {
        console.warn(`Image download failed (${res.status()}) for ${imgUrl}`);
        continue;
      }

      // 3) 바디 버퍼 획득
      const buffer = await res.body();

      // 확장자 추출
      const ext = path.extname(new URL(imgUrl).pathname) || '.png';

      // S3 업로드 (filenameBase에 index를 넘겨 고유명 생성)
        if(ext != '.svg'){
        const s3Path = await this.s3Service.saveImgToS3(
          buffer,
          ext,
          'img',
          `${Date.now()}_${i}`,
          configId,
        );

        results.push({
          url: imgUrl,
          caption,
          s3Path,
        });
      }
    }

    return results;
  }

  /**
   * 페이지에서 파일(PDF 등)을 다운로드하고 S3에 업로드한다.
   * 다운로드 이벤트를 감지하여 파일을 임시 저장한 뒤 S3로 전송한다.
   * 파일명에서 공백/쉼표를 제거하고, 확장자가 없으면 .pdf를 추가한다.
   * KDI 사이트의 경우 특별한 클릭 처리를 수행한다.
   */
  async handleFileStep(page: Page, target: any, configId: number, title?: string, webhook = true) {
    let { selector } = target;

    // 73번 파일 시각화 클릭 필요
    if (page.url().includes('www.kdi.re.kr')) {
      const fileBubbleButtons = page.locator(
        '.rpt_link button[onclick*="fileBubble"]',
      );
      const count = await fileBubbleButtons.count();
      if (count > 0) {
        await page.locator('.rpt_link button').first().click();
      } else {
        selector = '.rpt_link button';
      }
    }
    await page.waitForSelector(selector, { state: 'attached', timeout: 5000 });

    const handles = await page.locator(`${selector}:visible`).elementHandles();
    const output: Array<{ originalName: string; s3Path: string }> = [];

    for (const handle of handles) {
      if (!(await handle.isVisible())) continue;

      // KINU fileDown1: onclick에서 ID를 파싱하여 직접 다운로드
      if (page.url().includes('www.kinu.or.kr')) {
        const onclickVal = await handle.getAttribute('onclick');
        const fileDown1Match = onclickVal?.match(/fileDown1\('(.+?)'\)/);
        if (fileDown1Match && fileDown1Match[1]) {
          const fileId = fileDown1Match[1];
          const downloadUrl = `https://www.kinu.or.kr/main/module/report/download.do?id=${fileId}`;
          try {
            const res = await page.context().request.get(downloadUrl);
            if (!res.ok()) {
              console.warn(`⚠️ KINU 파일 다운로드 실패 (${res.status()}): ${downloadUrl}`);
              continue;
            }
            const buffer = Buffer.from(await res.body());
            const originalName = title ? `${title.replace(/[\s,+/\\:*?"<>|]+/g, '_')}.pdf` : `${fileId}.pdf`;
            const tempPath = path.join(process.cwd(), 'tmp', `${Date.now()}_${originalName}`);
            await fs.mkdir(path.dirname(tempPath), { recursive: true });
            await fs.writeFile(tempPath, buffer);

            const key = await this.s3Service.saveFileToS3(tempPath, configId, originalName);
            await fs.unlink(tempPath);
            output.push({ originalName, s3Path: key });
          } catch (e) {
            console.warn(`⚠️ KINU fileDown1 다운로드 실패 (${(e as Error).message})`);
          }
          continue;
        }
      }

      // 1차: 클릭 기반 다운로드 시도
      let download;
      try {
        const downloadPromise = page.waitForEvent('download', {
          timeout: 25000,
        });
        await handle.click();
        download = await Promise.race([
          downloadPromise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('download timeout')), 20000),
          ),
        ]);
      } catch (e) {
        // 2차: 클릭 실패 시 href fallback
        const hrefVal = await handle.getAttribute('href');
        if (hrefVal && !hrefVal.startsWith('javascript:')) {
          try {
            const downloadUrl = new URL(hrefVal, page.url()).href;
            const res = await page.context().request.get(downloadUrl);
            if (!res.ok()) {
              console.warn(`⚠️ href 파일 다운로드 실패 (${res.status()}): ${downloadUrl}`);
              continue;
            }
            const buffer = Buffer.from(await res.body());
            const originalName = await this.extractFilenameFromResponse(res, handle, downloadUrl, title);
            console.log('파일명:', `${Date.now()}_${originalName}`);

            const tempPath = path.join(process.cwd(), 'tmp', `${Date.now()}_${originalName}`);
            await fs.mkdir(path.dirname(tempPath), { recursive: true });
            await fs.writeFile(tempPath, buffer);

            const key = await this.s3Service.saveFileToS3(tempPath, configId, originalName);
            await fs.unlink(tempPath);
            output.push({ originalName, s3Path: key });
          } catch (hrefErr) {
            console.warn(`⚠️ href fallback 실패 (${(hrefErr as Error).message}), 다음으로 넘어갑니다`);
          }
        } else {
          console.warn(`⚠️ 다운로드 실패 (${(e as Error).message}), 다음으로 넘어갑니다`);
        }
        continue;
      }

      let originalName = download.suggestedFilename();
      originalName = originalName.replace(/[\s,+]+/g, '');

      const tail = originalName.slice(-5);
      if (!tail.includes('.')) {
        let displayedName: string | null = null;
        try {
          const linkHandle = await page.locator(selector).first();
          displayedName = (await linkHandle.textContent())?.trim() || null;
        } catch {
          displayedName = null;
        }

        if (displayedName && !/원문|다운로드|다운|download|보기/i.test(displayedName)) {
          originalName = displayedName.replace(/\s+/g, '');
          if (!originalName.slice(-5).includes('.')) originalName += '.pdf';
        } else {
          originalName += '.pdf';
        }
      }
      console.log('파일명:', `${Date.now()}_${originalName}`);

      const tempPath = path.join(
        process.cwd(),
        'tmp',
        `${Date.now()}_${originalName}`,
      );
      await fs.mkdir(path.dirname(tempPath), { recursive: true });
      await download.saveAs(tempPath);

      const key = await this.s3Service.saveFileToS3(
        tempPath,
        configId,
        originalName,
      );
      await fs.unlink(tempPath);

      output.push({ originalName, s3Path: key });
    }

    // 비정상 확장자(.do 등) 또는 확장자 없는 파일이 포함되면 null 리턴 → 기사 skip
    const invalidExts = ['.do', '.es', '.jsp', '.asp', '.php', '.action'];
    for (const file of output) {
      const ext = path.extname(file.originalName).toLowerCase();
      if (!ext) {
        console.warn(`⚠️ 파일 확장자 없음 (${file.originalName}), 기사 skip`);
        this.googleChatService.sendAlert('파일 확장자 없음 - 셀렉터 확인 필요', {
          'configId': `${configId}`,
          '파일명': file.originalName,
          'URL': page.url(),
        }, webhook);
        return null;
      }
      if (invalidExts.includes(ext)) {
        console.warn(`⚠️ 비정상 파일 확장자 감지 (${file.originalName}), 기사 skip`);
        this.googleChatService.sendAlert('비정상 파일 확장자 감지', {
          'configId': `${configId}`,
          '파일명': file.originalName,
          '확장자': ext,
          'URL': page.url(),
        }, webhook);
        return null;
      }
    }

    return output;
  }

  /**
   * 페이지의 네트워크 응답을 모니터링하여 비디오 URL을 탐지하고 다운로드한다.
   * mp4, m3u8, webm 등 다양한 비디오 포맷과 Content-Type을 감지한다.
   * 재생 버튼을 클릭하여 비디오 로딩을 트리거한다.
   */
  async videoScrap(browser: any, pageUrl: string) {
    const page = await browser.newPage();
    const videoUrls = new Set<string>();

    // 1) 모든 response 이벤트 리스닝
    page.on('response', (response) => {
      const url = response.url();
      const ct = (response.headers()['content-type'] || '').toLowerCase();

      // URL 확장자 체크
      const extMatch = url.match(
        /\.(mp4|m3u8|webm|ogg|mov|m4v|flv|ts|mpd)(\?.*)?$/i,
      );
      // 또는 Content-Type 기반 체크
      const ctMatch =
        ct.startsWith('video/') ||
        ct.includes('application/vnd.apple.mpegurl') || // HLS
        ct.includes('application/dash+xml'); // DASH

      if (extMatch || ctMatch) {
        videoUrls.add(url);
      }
    });

    await page.goto(pageUrl, { waitUntil: 'networkidle' });

    // 2) Play 버튼 눌러 재생 트리거
    await page.click('.powa-click-promo-play');
    await page.waitForTimeout(3000); // 네트워크 로딩 시간 확보

    // 3) 발견된 URL 중 첫 번째 사용
    const [rawUrl] = Array.from(videoUrls);
    if (!rawUrl) throw new Error('비디오 URL을 찾을 수 없습니다');

    // 4) 다운로드
    const filename = rawUrl.split('/').pop();
    const savePath = path.join(process.cwd(), 'downloads', filename);
    await fs.mkdir(path.dirname(savePath), { recursive: true });
    await this.downloadFile(rawUrl, savePath);

    await page.close();
    return { videoPath: savePath };
  }

  /**
   * video 태그에서 src 속성을 추출하고 커스텀 정규식 변환을 적용하여 다운로드한다.
   * 상대경로를 절대경로로 변환하는 customTransform을 지원한다.
   */
  async videoScrap1(browser: any, pageUrl: string) {
    const detailFields = [
      {
        type: 'file',
        name: 'video',
        selector: 'video.vjs-tech', // <video> 태그 선택자
        attribute: 'src', // 파일 URL을 가져올 속성
        // 필요하다면 상대경로 → 절대경로 변환
        customTransform: {
          type: 'regex',
          pattern: '^(\\/store\\/voddata\\/.*\\.mp4)$',
          output: 'https://your.domain.com${1}',
        },
      },
    ];
    const page = await browser.newPage();
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });

    // detailFields 중 video 정의 찾기
    const videoField = detailFields.find((f) => f.name === 'video');
    if (!videoField) throw new Error('Video field not defined');

    // 페이지에서 URL 추출
    let rawUrl = (await page.$eval(
      videoField.selector,
      (el, attr) => (el as any)[attr],
      videoField.attribute,
    )) as string;

    // customTransform 적용
    if (videoField.customTransform) {
      const { pattern, output } = videoField.customTransform;
      rawUrl = rawUrl.replace(new RegExp(pattern), output);
    }

    // 다운로드 경로 결정
    const filename = `video-${Date.now()}.mp4`;
    const savePath = path.join(process.cwd(), 'downloads', filename);

    // 파일 다운로드
    await this.downloadFile(rawUrl, savePath);

    await page.close();
    return { videoPath: savePath };
  }

  /**
   * URL에서 파일을 다운로드하여 로컬 파일시스템에 저장한다.
   * fetch API와 Node.js 스트림을 사용하여 대용량 파일도 메모리 효율적으로 처리한다.
   */
  async downloadFile(url: string, outputPath: string): Promise<void> {
    const dir = path.dirname(outputPath);
    // 비동기 생성
    await fs.mkdir(dir, { recursive: true });

    const res = await fetch(url);
    if (!res.ok) throw new Error(`다운로드 실패: ${res.status}`);

    const webStream = res.body as unknown as WebReadableStream<Uint8Array>;
    const nodeStream = Readable.fromWeb(webStream);

    const fileStream = createWriteStream(outputPath);
    await new Promise<void>((resolve, reject) => {
      nodeStream.pipe(fileStream);
      nodeStream.on('error', reject);
      fileStream.on('finish', resolve);
    });
  }

  /**
   * HTTP 응답에서 파일명을 추출한다.
   * 우선순위: Content-Disposition 헤더 → 링크 텍스트 → URL 경로 → title fallback
   */
  private async extractFilenameFromResponse(
    res: any,
    handle: any,
    downloadUrl: string,
    title?: string,
  ): Promise<string> {
    // 1) Content-Disposition 헤더
    const disposition = res.headers()['content-disposition'] || '';
    const cdMatch = disposition.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i);
    if (cdMatch && cdMatch[1]) {
      const name = decodeURIComponent(cdMatch[1]).replace(/["]/g, '').trim().replace(/[\s,+]+/g, '');
      if (name && name.slice(-5).includes('.')) return name;
    }
    // 2) 링크 텍스트
    const linkText = ((await handle.textContent()) || '').trim().replace(/[\s,+]+/g, '');
    if (linkText && linkText.slice(-5).includes('.')) return linkText;
    // 3) URL 경로 (.do 등 제외)
    const urlBase = path.basename(new URL(downloadUrl).pathname);
    if (urlBase.slice(-5).includes('.') && !urlBase.endsWith('.do')) return urlBase;
    // 4) title fallback
    return (title ? title.replace(/[\s,+/\\:*?"<>|]+/g, '_') : 'download') + '.pdf';
  }
}
