/**
 * 코드 인덱스 공용 타입.
 *
 * repo-map이 만들고 trace-flow가 읽는다. 두 툴의 유일한 계약이다.
 */

export type Lang = 'kotlin' | 'java' | 'typescript';

export type Annotation = { name: string; args?: string };

export type MethodSymbol = {
  name: string;
  line: number;
  /** 메서드 본문의 [시작, 끝) 오프셋. 호출 추출 범위. */
  bodyStart: number;
  bodyEnd: number;
  annotations: Annotation[];
  /** 본문에서 발견한 호출: receiver(변수/타입명) + 메서드명 */
  calls: CallSite[];
};

export type CallSite = { receiver: string | null; method: string; line: number };

/** 의존성 주입으로 들어온 필드/생성자 파라미터. 호출 수신자 타입 해석의 근거. */
export type DiField = { name: string; type: string; line: number };

export type TypeSymbol = {
  name: string;
  kind: 'class' | 'interface' | 'object' | 'enum' | 'annotation';
  line: number;
  annotations: Annotation[];
  /** implements/extends 대상. 인터페이스 → 구현체 해석에 쓴다. */
  supertypes: string[];
  fields: DiField[];
  methods: MethodSymbol[];
};

export type Endpoint = {
  /** "POST /v1/orders" 또는 "KafkaListener order.created" */
  key: string;
  kind: 'http' | 'message' | 'schedule' | 'event';
  typeName: string;
  methodName: string;
  line: number;
};

export type FileSymbols = {
  path: string;
  lang: Lang;
  packageName: string | null;
  imports: string[];
  types: TypeSymbol[];
  endpoints: Endpoint[];
};

/** 스캐너가 해석하지 못한 지점. 숨기지 않고 인덱스에 남긴다 (설계원칙 P9). */
export type ScanGap = { path: string; line: number; reason: string; detail?: string };
