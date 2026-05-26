export const test_config = {
  id: 57,
  name: '통일연구원',
  scheduleTime: ['00:00'],
  baseUrl: 'https://www.kinu.or.kr',
  startUrl: [
    'https://www.kinu.or.kr/main/module/report/index.do?viewPage=1&nav_code=mai1674786094&category=44&order_list=new&search_text=%EB%B6%81%ED%95%9C',
  ],
  steps: [
    {
      id: 'id1',
      type: 'detailLinks',
      params: {
        selector: '.bx .cont .desc a',
        attribute: 'href',
      },
      next: [],
    },
    {
      id: 'goToDetail',
      type: 'scrapDetail',
      params: {
        targets: [
          {
            type: 'uniqueText',
            name: 'title',
            selector: '.info .subject',
          },
          {
            type: 'uniqueText',
            name: 'author',
            selector: 'dt:has-text("저자") + dd',
          },
          {
            type: 'uniqueText',
            name: 'date',
            selector: 'dt:has-text("발행일") + dd',
          },
          {
            type: 'duplicatedText',
            name: 'content',
            selector: '.cont .cont_toc',
          },
          {
            type: 'file',
            name: 'pdf',
            // selector: '[onclick^="fileDown2(\'"]',
            selector: 'a.btn-pdf-down',
          },
          {
            id: 'thumbnails',
            type: 'images',
            name: 'images',
            params: {
              containerSelector: '.thumb-area',
              selector: '.thumb-area img',
              captionSelector: 'figcaption, .caption',
            },
            next: [],
          },
        ],
      },
      next: [],
    },
  ],
  description: '대사관',
  enabled: false,
  lastExecutedAt: '2025-04-18T13:34:26.737Z',
  createdAt: '2025-04-18T13:34:26.737Z',
  updatedAt: '2025-04-18T13:34:26.737Z',
};

export const test_config_1 = {
  id: 57,
  name: '주 독일 대한민국 대사관',
  scheduleTime: ['00:00'],
  baseUrl: 'https://overseas.mofa.go.kr',
  startUrl: [
    'https://overseas.mofa.go.kr/de-ko/brd/m_7204/list.do?srchTp=1&srchWord=%EB%B6%81%ED%95%9C',
  ],
  steps: [
    {
      id: 'id1',
      type: 'detailLinks',
      params: {
        selector: "a[onclick^='f_view']",
        attribute: 'onclick',
      },
      next: [],
    },
    {
      id: 'goToDetail',
      type: 'scrapDetail',
      params: {
        targets: [
          {
            type: 'uniqueText',
            name: 'title',
            selector: '.board_detail .bo_head h2',
          },
          {
            type: 'uniqueText',
            name: 'author',
            selector: "dt:has-text('작성자') + dd",
          },
          {
            type: 'uniqueText',
            name: 'date',
            selector: "dt:has-text('작성일') + dd",
          },
          {
            type: 'duplicatedText',
            name: 'content',
            selector: '.bo_con .se-contents p',
          },
        ],
      },
      next: [],
    },
    // {
    //   id: 'goToDetail',
    //   type: 'clickNavigate',
    //   params: {
    //     selector: "a[onclick^='f_view']",
    //   },
    //   next: ['captureDetailUrl'],
    // },
    // {
    //   id: 'captureDetailUrl',
    //   type: 'extract',
    //   params: {
    //     source: 'url',
    //     field: 'detailUrl',
    //   },
    // },
  ],
  description: '대사관',
  enabled: false,
  lastExecutedAt: '2025-04-18T13:34:26.737Z',
  createdAt: '2025-04-18T13:34:26.737Z',
  updatedAt: '2025-04-18T13:34:26.737Z',
};
