/** Mock schema: id, text, type, pronunciation, partOfSpeech, definition, etymology, comparisons[], examples[]. */
export const entries = [
  {
    id: 'parking-space', text: 'parking space', type: 'phrase', pronunciation: '/ˈpɑːrkɪŋ speɪs/', partOfSpeech: 'noun phrase',
    definition: 'an area where a vehicle can be left for a period of time',
    etymology: 'parking 来自动词 park（停放）；space 指可供使用的空间。组合后专指供一辆车停放的位置。',
    comparisons: [
      { word: 'parking space', note: '具体的一个停车位，常用于住宅或停车场。' },
      { word: 'parking lot', note: '停车场，指容纳许多车辆的整片区域。' },
      { word: 'parking spot', note: '口语表达，含义接近 parking space。' },
    ],
    examples: [
      { text: 'We finally found a parking space near the station.', translation: '我们终于在车站附近找到了一个停车位。' },
      { text: 'This parking space is reserved for residents.', translation: '这个停车位是留给住户的。' },
    ],
  },
  {
    id: 'quiet', text: 'quiet', type: 'word', pronunciation: '/ˈkwaɪət/', partOfSpeech: 'adjective',
    definition: 'making little or no noise; calm and peaceful',
    etymology: '源自拉丁语 quietus（安静的、休息的），经古法语进入英语。',
    comparisons: [
      { word: 'quiet', note: '声音小、不吵闹；也可形容环境平静。' },
      { word: 'silent', note: '完全没有声音，语气比 quiet 更绝对。' },
      { word: 'calm', note: '强调情绪或局面平稳，不一定指声音。' },
    ],
    examples: [{ text: 'We found a quiet street behind the museum.', translation: '我们在博物馆后面找到了一条安静的街道。' }],
  },
  {
    id: 'behind', text: 'behind', type: 'word', pronunciation: '/bɪˈhaɪnd/', partOfSpeech: 'preposition / adverb',
    definition: 'at or to the far side of something; in a position at the back',
    etymology: '由古英语 be-（在……处）与 hindan（后方）构成，核心意象是“在后面”。',
    comparisons: [
      { word: 'behind', note: '在某物后方，可指空间位置或落后于进度。' },
      { word: 'in back of', note: '口语中表示在……后面，常见于美式英语。' },
      { word: 'after', note: '主要表示时间或顺序上的“之后”。' },
    ],
    examples: [{ text: 'The café is just behind the old library.', translation: '咖啡馆就在旧图书馆后面。' }],
  },
  {
    id: 'finally', text: 'finally', type: 'word', pronunciation: '/ˈfaɪnəli/', partOfSpeech: 'adverb',
    definition: 'after a long time, or at the end of a series of events',
    etymology: '由 final（最终的）加副词后缀 -ly 构成，用来标记过程的终点或期待已久的结果。',
    comparisons: [
      { word: 'finally', note: '强调等待或过程结束后终于发生。' },
      { word: 'eventually', note: '强调经过一段时间最终发生，等待感稍弱。' },
      { word: 'at last', note: '语气更强，常带有松一口气或不耐烦的情绪。' },
    ],
    examples: [{ text: 'She finally finished the book on the train.', translation: '她终于在火车上读完了那本书。' }],
  },
]

export const passage = [
  { text: 'After', punctuation: ' ', entryId: null },
  { text: 'hours', punctuation: ' ', entryId: null },
  { text: 'of', punctuation: ' ', entryId: null },
  { text: 'driving,', punctuation: ' ', entryId: null },
  { text: 'we', punctuation: ' ', entryId: null },
  { text: 'finally', punctuation: ' ', entryId: 'finally' },
  { text: 'found', punctuation: ' ', entryId: null },
  { text: 'a', punctuation: ' ', entryId: null },
  { text: 'quiet', punctuation: ' ', entryId: 'quiet' },
  { text: 'parking space', punctuation: ' ', entryId: 'parking-space' },
  { text: 'behind', punctuation: ' ', entryId: 'behind' },
  { text: 'the', punctuation: ' ', entryId: null },
  { text: 'museum.', punctuation: '', entryId: null },
]
