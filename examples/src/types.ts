// ═══════════════════════════════════════════════════════════════════════════
// examples 共享类型：模型配置 + MBTI 角色画像
//
// 只依赖公开的 `@pi/agent-role` 类型面（createRuntime + Runtime）。为不泄漏内部
// `ModelCredential`（未在公开入口再导出），这里自声明一个结构等价的小类型，交给
// `createRuntime({ credentialFor })` 时按结构兼容装配。
// ═══════════════════════════════════════════════════════════════════════════

/** 单个 provider 的凭据描述（与 mesh examples/demo.config.json 同构）。 */
export interface DemoProvider {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  apiKeyEnv?: string;
}

/** `llm` 段：`model` 形如 "provider:modelId"；`providers` 给出凭据目录。 */
export interface DemoLlmConfig {
  model: string;
  thinkingLevel?: string;
  providers?: Record<string, DemoProvider>;
}

/** demo.config.json 的根形状。 */
export interface DemoConfig {
  llm?: DemoLlmConfig;
}

/** 标准化后的模型规格（平台无关，喂给 createRuntime）。 */
export interface DemoModelSpec {
  provider: string;
  modelId: string;
  thinkingLevel: "off" | "low" | "medium" | "high";
  credential: { type: "api_key"; key: string; baseUrl?: string; api?: string };
}

/** MBTI 画像：全部来自模板数据，代码零角色分支（对应库的 C1 纪律）。 */
export interface PersonaSpec {
  /** 小写 MBTI，兼作 blueprint 目录名与 agentId（agentId=mbti 小写）。 */
  id: string;
  /** 大写 MBTI（INTJ / ENFP …）。 */
  mbti: string;
  /** 中文别称（建筑师 / 竞选者 …）。 */
  title: string;
  /** 对外展示名（一个中文名）。 */
  displayName: string;
  personal: { name: string; age: number; gender: string; role: string };
  /** psychology.yaml 里的 personality（进 system prompt「你是谁」）。 */
  personality: string[];
  /** 大五（openness/conscientiousness/neuroticism 会被记忆策略编译器读取）。 */
  bigFive: {
    openness: number;
    conscientiousness: number;
    extraversion: number;
    agreeableness: number;
    neuroticism: number;
  };
  emotion: { empathyLevel: number };
  attachmentStyle: "secure" | "anxious" | "avoidant";
  cognition: { attentionSpan: "sustained" | "scattered" };
  sensory: {
    noticingPattern: "detail_oriented" | "big_picture";
    dominantChannel: "visual" | "auditory" | "tactile" | "olfactory";
    blindspots: string[];
  };
  voice: {
    defaultMode: string;
    sentenceStarters: string[];
    enders: string[];
    punctuationStyle: string;
    metaphorDomains: string[];
  };
  constraints: Array<{ id: string; text: string; severity: "hard" | "soft" }>;
  mood: string;
  moodIntensity: number;
  energy: number;
  goals: { immediate: string };
}