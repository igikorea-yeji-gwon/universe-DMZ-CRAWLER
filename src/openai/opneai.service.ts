import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import * as dotenv from 'dotenv';
import { PromptParams } from 'src/scraper/types/scraper.type';

dotenv.config();

@Injectable()
export class OpenAIService {
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY, // 환경변수로 API 키 관리
    });
  }

  async askQuestion(prompt: string): Promise<string> {
    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: prompt }],
        // max_tokens: 100,
      });

      const result = response.choices[0].message.content.trim();

      return result;
      // return '';
    } catch (error) {
      console.error('OpenAI API 실패:', error);
      throw error;
    }
  }

  buildListPrompt({
    exampleJson,
    url,
    dUrl,
    html,
  }: {
    exampleJson: string;
    url: string;
    dUrl: string;
    html: string;
  }): string {
    return `
    다음은 웹 스크래핑을 위한 정의 JSON을 자동 생성하기 위한 요청이다.  
    아래의 조건과 데이터를 참고하여 스키마를 구성하고, **최종적으로는 baseUrl, useBrowser, searchFields 가 포함된 정의 JSON만 결과로 출력**하라.
    
    [요청 조건]
    1. baseUrl은 목록 페이지 URL의 origin 으로 설정.  
    
    2. 목록 항목 링크가 **<a> 태그의 href 없이 onclick 이벤트 핸들러로 동적으로 URL을 생성하는 경우**:  
      - "useBrowser": true  
      - searchFields[0]에 "attribute": "onclick" 와 "customTransform" 블록을 반드시 포함.  
    
    3. <a href="…"> 형태의 링크만 있으면:  
      - "useBrowser": false  
      - "attribute"와 "customTransform" 필드는 제외.  
       
    4. 목록 페이지의 셀렉터를 통한 상세페이지 url을 추출하는 로직은 아래와 같다
       \`\`\`
       const detailLinks = $(\`\${field.selector}\`)
         .map((i, el) => {
           const linkEl = $(el).is('a') ? $(el) : $(el).find('a');
           return linkEl.attr('href');
         })
         .get();
       \`\`\`
        
    5. 참고용 예시 정의 JSON은 스키마 예시일 뿐이며, 결과로 출력되는 JSON은 아래 HTML 분석을 기반으로 새롭게 생성한다.
    
    6. 위 조건에 따라 생성된 정의 JSON만 출력하라. **설명, 주석, 추가 텍스트 없이 JSON 객체만 반환한다.**
    
    [입력]
    ### 예시 정의 JSON
    \`\`\`
    ${exampleJson.trim()}
    \`\`\`
    
    ### 목록 페이지 정보
    - URL: ${url}
    - HTML:
    \`\`\`
    ${html.trim()}
    \`\`\`

    ### 상세 페이지 정보
    - URL: ${dUrl}
    
    => 정보를 입력으로 받아, 위 조건에 맞는 정의 JSON을 출력하라.
    `.trim();
  }

  buildDetailPrompt({ exampleJson, url, html }: PromptParams): string {
    return `
  다음은 웹 스크래핑을 위한 정의 JSON을 자동 생성하기 위한 요청이다.  
  아래의 조건과 데이터를 참고하여 스키마를 구성하고, **최종적으로는 정의 JSON만 결과로 출력**하라.
  
  [요청 조건]
  
  1. 입력된 **상세페이지 HTML**의 구조를 기반으로 다음 \`detailFields\` 항목들을 가능한 한 설정한다.
     - \`title\`: 제목
     - \`author\`: 작성자
     - \`writedate\`: 작성일
     - \`content\`: 본문 내용
     - \`thumbnail\`: 썸네일 이미지들
     - \`img\`: 본문 이미지들
     - \`imgCaption\`: 이미지 캡션
     - \`file\`: 첨부 파일들
  
  2. 항목이 **존재하지 않으면 해당 필드는 제외**한다.
  
  3. 참고용 예시 정의 JSON은 스키마 예시일 뿐이며, 결과로 출력되는 JSON은 아래 HTML 분석을 기반으로 새롭게 생성한다.
  
  4. 위 조건에 따라 생성된 정의 JSON만 출력하라. **설명, 주석, 추가 텍스트 없이 JSON 객체만 반환한다.**
  
  [입력]
  ### 예시 정의 JSON
  \`\`\`
  ${exampleJson.trim()}
  \`\`\`
  
  ### 상세 페이지 정보
  - URL: ${url}
  - HTML:
  \`\`\`
  ${html.trim()}
  \`\`\`
  
  => 정보를 입력으로 받아, 위 조건에 맞는 정의 JSON을 출력하라.
    `.trim();
  }

  async analyzeContent(title: string, content: string): Promise<boolean> {
    const prompt = `다음 기사가 '북한'과 '남북'에 관련되었는지 판단해주세요.
    - 제목: ${title}
    - 내용: ${content.substring(0, 200)}
    답변은 반드시 "참" 또는 "거짓" 중 하나만 반환하세요. (참:
    1. 대한민국과 북한이라는 나라를 의미하는 '남북'이라는 의미의 단어가 사용되며, 정치적인 의미를 담은 기사
    2. 북한의 정치인 '김정은', '김여정', '김정일' 등이 언급된 기사
    3. '북한이탈주민'이 언급된 기사
    ,
    거짓:
    1. '동서남북'과 같이 중간에 남북이 끼어있는 단어
    2. '북한산'과 '북한대학원'과 같이 단순히 지명 단어만을 사용한 경우
    3. '김정은의 초콜릿' 처럼 북한 정치인이 아닌 사람의 이름이 사용된 경우
    )`;
    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'developer',
            content:
              '너는 기사를 읽고 맥락을 파악하여 참 또는 거짓을 판별하는 도우미야',
          },
          { role: 'user', content: prompt },
        ],
        max_tokens: 30,
      });
      const result = response.choices[0].message.content.trim();
      return result === '참';
    } catch (error) {
      console.error('OpenAI 분석 실패:', error);
      return false;
    }
  }
}
