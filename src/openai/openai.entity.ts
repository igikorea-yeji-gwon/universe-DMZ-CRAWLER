export class AiDto {
  title!: string;
  content!: string;
}

export const initTestJson = {
  name: 'niss', // 스크랩 대상 이름 변경 X
  scheduleTime: ['14:30', '14:50'], // 스크랩 대상 이름 변경 X
  baseUrl: 'https://inss.re.kr', // 검색 url을 통해 오리진 url 업데이트
  searchUrl: ['https://inss.re.kr/publication/bbs/ib_list.do'], // 검색 url 리스트 변경X
  description: 'dddd', // 스크랩 대상 설명 변경 X
  useBrowser: true, // 목록 url의 페이지에서 상세페이지 url로 추출 시 true, href로 획득 가능 시 false
  searchUrlKey: 'SPN_URL', // key 필요 시 입력 사항으로 변경 X
  searchFields: [
    // 목록 url의 html에서 상세페이지 url을 획득하기 위한 셀렉터 설정
    {
      fieldType: 'list', // 선택 타입
      selector: 'li .txtBox > a', // 상세 url 획득 셀렉터
      attribute: 'onclick', // 이벤트를 통해 상세url 획득 필요시 입력
      customTransform: {
        // 이벤트를 통해 상세url 획득 필요시 입력
        type: 'regex', // 이벤트를 통해 상세url 획득 필요시 입력
        pattern: "setView\\('(\\d+)',\\s*'(\\w+)'\\)", // 이벤트를 통해 상세url 획득 필요시 입력
        output:
          'https://inss.re.kr/publication/bbs/${2}_view.do?nttId=${1}&bbsId=${2}&page=1&searchCnd=100&searchWrd=', // 이벤트를 통해 상세url 획득 필요시 입력
      },
    },
    {
      fieldType: 'paging', // 기본값, 변경 X
      selector: '',
    },
    {
      fieldType: 'pageNext', // 기본값, 변경 X
      selector: '',
    },
  ],
  detailFields: [
    // 상세페이지 셀렉터 리스트
    {
      fieldType: 'title', // 제목
      selector: '.txtBox p',
    },
    {
      fieldType: 'author', // 작성자
      selector: "dt:contains('저자') + dd",
    },
    {
      fieldType: 'writedate', // 작성일
      selector: "dt:contains('발행일') + dd",
    },
    {
      fieldType: 'content', // 본문
      selector: '#view_content p',
    },
    {
      fieldType: 'thumbnail', // 썸네일 들
      selector: '.imgBox img',
      srcReplace: {
        old: '&fileSn=0',
        new: '&fileSn=0',
      },
    },
    {
      fieldType: 'img', // 이미지들
      selector: '#view_content img',
      srcReplace: {
        old: '&fileSn=0',
        new: '&fileSn=0',
      },
    },
    {
      fieldType: 'imgCaption', // 이미지 캡션 들
      selector: '#view_content figcaption',
    },
    {
      fieldType: 'file', // 첨부파일
      selector: '.btnDown',
      attribute: 'onclick',
      customTransform: {
        type: 'regex',
        pattern: "fileDown1\\('([\\w\\d]+)'\\)",
        output: 'https://www.kinu.or.kr/main/module/report/download.do?id=${1}',
      },
    },
  ],
};

export const initListJson = {
  baseUrl: 'https://inss.re.kr',
  useBrowser: true,
  searchFields: [
    {
      fieldType: 'list', // 선택 타입
      selector: 'li .txtBox > a', // 상세 url 획득 셀렉터
      attribute: 'onclick', // 이벤트를 통해 상세url 획득 필요시 입력
      customTransform: {
        // 이벤트를 통해 상세url 획득 필요시 입력
        type: 'regex', // 이벤트를 통해 상세url 획득 필요시 입력
        pattern: "setView\\('(\\d+)',\\s*'(\\w+)'\\)", // 이벤트를 통해 상세url 획득 필요시 입력
        output:
          'https://inss.re.kr/publication/bbs/${2}_view.do?nttId=${1}&bbsId=${2}&page=1&searchCnd=100&searchWrd=', // 이벤트를 통해 상세url 획득 필요시 입력
      },
    },
    {
      fieldType: 'paging', // 기본값, 변경 X
      selector: '',
    },
    {
      fieldType: 'pageNext', // 기본값, 변경 X
      selector: '',
    },
  ],
};

export const initDetailJson = {
  detailFields: [
    // 상세페이지 셀렉터 리스트
    {
      fieldType: 'title', // 제목
      selector: '.txtBox p',
    },
    {
      fieldType: 'author', // 작성자
      selector: "dt:contains('저자') + dd",
    },
    {
      fieldType: 'writedate', // 작성일
      selector: "dt:contains('발행일') + dd",
    },
    {
      fieldType: 'content', // 본문
      selector: '#view_content p',
    },
    {
      fieldType: 'thumbnail', // 썸네일 들
      selector: '.imgBox img',
      srcReplace: {
        old: '&fileSn=0',
        new: '&fileSn=0',
      },
    },
    {
      fieldType: 'img', // 이미지들
      selector: '#view_content img',
      srcReplace: {
        old: '&fileSn=0',
        new: '&fileSn=0',
      },
    },
    {
      fieldType: 'imgCaption', // 이미지 캡션 들
      selector: '#view_content figcaption',
    },
    {
      fieldType: 'file', // 첨부파일
      selector: '.btnDown',
      attribute: 'onclick',
      customTransform: {
        type: 'regex',
        pattern: "fileDown1\\('([\\w\\d]+)'\\)",
        output: 'https://www.kinu.or.kr/main/module/report/download.do?id=${1}',
      },
    },
  ],
};
