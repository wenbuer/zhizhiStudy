//! LLM 调用：整理材料、生成考点、评判作答（OpenAI 兼容接口）。

use std::time::Duration;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::settings::Settings;
use crate::store::CardDigest;

const GRADE_SYSTEM: &str = "你是一位严格但公正的技术面试官。\
对照参考答案评判面试者的回答，判断概念是否准确、机制与权衡是否讲清。\
输出 JSON 对象：score（0-10 的数字，6 分及格）、\
feedback（2-4 句评语，先肯定答对的部分，再指出问题）、\
missed（遗漏的关键点字符串数组，没有则空数组）、\
suggestion（2-4 句理想回答）。\
只输出 JSON 对象，不要任何解释。";

const PAPER_SYSTEM: &str = "你是命题老师。用户会给你一个知识点的标题与正文，以及要出的题型与分值。\
请严格按用户要求的题型和数量出题，输出 JSON 数组，每个元素形如：\
{\"kind\":\"题型（原样用用户给的英文标识）\",\
\"stem\":\"题干\",\
\"options\":[\"选项 A 的内容\",\"选项 B 的内容\"],\
\"answer\":\"标准答案\",\
\"explain\":\"解析，1-3 句，讲清为什么\",\
\"points\":分值数字}\
题型与写法：single 单选（4 个选项，answer 写选项字母如 B）；multi 多选（4-5 个选项，answer 写字母如 ACD）；\
judge 判断（options 固定为 [\"正确\",\"错误\"]，answer 写 正确 或 错误）；blank 填空（options 给空数组，answer 是填空答案，多个可接受写法用 | 分隔）；\
short 简答（options 空数组，answer 写参考答案的 3-5 个要点，用；分隔）；case 案例（options 空数组，answer 写解题要点）。\
硬要求：只考正文里明确写过的事实，不要编造；题干必须自足，不要出现「根据材料」「上文」这类指代；\
填空题不要给提示词位置标记以外的空；只输出 JSON 数组，不要任何解释或代码块围栏。";

const GRADE_ITEM_SYSTEM: &str = "你是阅卷老师。用户会给你一道题的题干、参考答案与考生作答，请按点给分。\
输出 JSON 对象：score（得分数字，0 到该题满分之间，可以给小数）、\
verdict（correct 全对 / partial 部分对 / wrong 基本不对）、\
feedback（2-4 句评语，先肯定答对的部分，再指出问题）、\
missed（遗漏的关键点字符串数组，没有则空数组）、\
suggestion（2-4 句理想答案）。只输出 JSON 对象。";

const ASK_SYSTEM: &str = "你是一位耐心的一对一老师。用户会给你一段学习材料原文和一个不懂的问题。用大白话回答，少堆术语，必须结合原文讲，不要泛泛而谈。输出 JSON 对象：answer（150-250 字，分 3-4 句：先一句话说人话，再打个比方，最后指出对应原文哪一句）、followups（3 条可以直接点的追问，每条不超过 18 字，分别对应「讲简单点」「举具体例子」「换条件会怎样」）。只输出 JSON 对象，不要解释、不要代码块围栏。";

const TRANSLATE_SYSTEM: &str = "你是翻译器。把用户选中的内容翻译成简体中文；如果原文已经是中文，就翻译成英文。只输出译文本身：不要解释、不要加引号、不要复述原文、不要写思考过程。";

const EXTRACT_SYSTEM: &str = "你是资料整理助手。用户会给你一段从网页或搜索结果里抓来的原始文本，\
把它整理成干净、可直接用于学习的中文 Markdown 材料：\
1. 完整保留原文的信息：事实、数据、步骤、代码、表格、注意事项与结论，一个都不要省；\
2. 只删掉导航、广告、登录提示、相关推荐、作者署名这类与内容无关的噪音；\
3. 保留层级结构，用 Markdown 标题、列表、表格、代码块组织；\
4. 多篇来源时按主题合并去重，不要逐篇罗列；\
5. 不要概括，不要写「等等」「略」，也不要写「本文介绍了」这类套话；\
6. 不要编造原文没有的内容；\
7. 如果文本只是长材料的一部分，就只整理这一段，不要加导语、总结或结尾。\
直接输出整理后的 Markdown，不要 JSON、不要代码块围栏、不要任何解释。";

const DIGEST_SYSTEM: &str = "你是面试题设计者。用户会给你一篇技术学习材料的标题与正文，请为它出一份考点，供读者读完后自测：\
summary（一句话说明这篇讲什么，不超过 40 字）、\
keyPoints（读者必须掌握的 3-6 个要点，每条一句话，尽量具体到机制、取舍或数字）、\
question（一道检验是否真的读懂的面试题，必须是问句）、\
answer（参考答案，覆盖全部 keyPoints）。\
正文已经完整保留给读者，所以不要复述、不要压缩、不要摘抄正文，只给考点本身。\
只输出 JSON 对象：{\"summary\": \"\", \"keyPoints\": [], \"question\": \"\", \"answer\": \"\"}，不要任何解释。";

const BOOK_OUTLINE_SYSTEM: &str = "你是课程主编。用户要编一本学习用的小书，会给你书名、学习目标，以及一份素材清单（每条带 key、所属章节、标题）。\
请据此设计全书目录：3-8 章，每章一个清晰的学习主题，按由浅入深排序。\
输出 JSON 数组，每个元素形如 {\"title\":\"章标题\",\"intro\":\"这一章讲什么、读完能获得什么，60-100 字\",\"keys\":[\"素材 key\", ...]}。\
硬要求：keys 只能引用清单里出现过的 key；同一条素材只能归到一章；一章至少 2 条素材；不要编造清单之外的内容；只输出 JSON 数组，不要代码块围栏。";

const BOOK_CHAPTER_SYSTEM: &str = "你是教材作者。用户给你一本书的书名、本章标题、本章范围，以及本章可用的素材原文（来自已整理的学习材料）。\
请写这一章的正文，输出 Markdown：\
1. 只用素材里写过的事实，不要编造数据、案例或引文，素材没讲的不补；\
2. 按逻辑排段落，用小标题（###）、列表、表格、代码块组织，让人能顺着读下去；\
3. 开头一两句话接手本章目标，结尾用 3-5 条要点收束；\
4. 正文 800-1600 字，不要写「本章将介绍」这类空话，不要重复书名；\
5. 直接输出正文 Markdown，不要代码块围栏、不要任何解释。";

/// 模型整理出来的材料。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedMaterial {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GradeResult {
    pub score: f64,
    pub feedback: String,
    #[serde(default)]
    pub missed: Vec<String>,
    #[serde(default)]
    pub suggestion: String,
}

/// 问答历史里的一问一答：多轮追问时按顺序带回去。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AskTurn {
    #[serde(default)]
    pub question: String,
    #[serde(default)]
    pub answer: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskAnswer {
    #[serde(default)]
    pub answer: String,
    #[serde(default)]
    pub followups: Vec<String>,
}

#[derive(Clone)]
pub struct LlmClient {
    http: reqwest::Client,
    api_key: String,
    base: String,
    model: String,
}

impl LlmClient {
    /// 从运行期设置构建客户端：接口地址、Key、代理都来自设置。
    pub fn from_settings(settings: &Settings) -> Result<Self> {
        let http = settings.build_http(240)?;
        let base = settings.api_base.trim().trim_end_matches('/').to_string();
        let key = settings.api_key.trim().to_string();
        Ok(Self {
            http,
            api_key: key,
            base,
            model: settings.model.trim().to_string(),
        })
    }

    /// 最小连通性测试：能拿到回复就说明 Key、地址、网络都通。
    pub async fn ping(&self) -> Result<String> {
        let messages = json!([{ "role": "user", "content": "只回复两个字：正常" }]);
        let reply = self.chat(messages, &self.model, 16, 0.0).await?;
        Ok(reply.trim().chars().take(40).collect())
    }

    pub fn ready(&self) -> bool {
        !self.api_key.is_empty()
    }

    /// 划词翻译：关掉思考、限时 30 秒，求快。接口不认 `thinking` 字段时退一步重发。
    pub async fn translate(&self, text: &str) -> Result<String> {
        let messages = json!([
            { "role": "system", "content": TRANSLATE_SYSTEM },
            { "role": "user", "content": text },
        ]);
        let no_think = json!({ "thinking": { "type": "disabled" } });
        match self
            .chat_extra(messages.clone(), &self.model, 1500, 0.1, Some(no_think), Some(30))
            .await
        {
            Ok(reply) => Ok(reply.trim().to_string()),
            Err(error) if rejects_thinking(&error) => {
                // 第三方 OpenAI 兼容服务不认这个字段：去掉它再发一次，别让翻译直接失败。
                self.chat_extra(messages, &self.model, 1500, 0.1, None, Some(30))
                    .await
                    .map(|reply| reply.trim().to_string())
            }
            Err(error) => Err(error),
        }
    }

    /// 划词问答：默认关思考、25 秒内返回；deep 才走思考模式，慢但更深入。
    pub async fn ask(
        &self,
        title: &str,
        passage: &str,
        question: &str,
        history: &[AskTurn],
        deep: bool,
    ) -> Result<AskAnswer> {
        let messages = ask_messages(title, passage, question, history);
        let raw = if deep {
            self.chat_extra(messages, &self.model, 2200, 0.3, None, Some(90)).await?
        } else {
            let no_think = json!({ "thinking": { "type": "disabled" } });
            match self
                .chat_extra(messages.clone(), &self.model, 1600, 0.3, Some(no_think), Some(25))
                .await
            {
                Ok(text) => text,
                Err(error) if rejects_thinking(&error) => {
                    self.chat_extra(messages, &self.model, 1600, 0.3, None, Some(25)).await?
                }
                Err(error) => return Err(error),
            }
        };
        let json_text = extract_json(&raw, '{', '}')?;
        let mut parsed: AskAnswer = serde_json::from_str(&json_text)
            .map_err(|e| anyhow!("问答 JSON 解析失败：{e}"))?;
        parsed.answer = parsed.answer.trim().to_string();
        parsed.followups = parsed.followups.into_iter().take(3).collect();
        Ok(parsed)
    }

    pub fn model_name(&self) -> &str {
        &self.model
    }

    async fn chat(&self, messages: Value, model: &str, max_tokens: u32, temperature: f32) -> Result<String> {
        self.chat_extra(messages, model, max_tokens, temperature, None, None).await
    }

    /// 在标准请求体上追加字段（如关闭思考）并可单独收紧超时；其余调用沿用默认值。
    async fn chat_extra(
        &self,
        messages: Value,
        model: &str,
        max_tokens: u32,
        temperature: f32,
        extra: Option<Value>,
        timeout_secs: Option<u64>,
    ) -> Result<String> {
        self.chat_at(
            &self.base,
            &self.api_key,
            messages,
            model,
            max_tokens,
            temperature,
            extra,
            timeout_secs,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn chat_at(
        &self,
        base: &str,
        key: &str,
        messages: Value,
        model: &str,
        max_tokens: u32,
        temperature: f32,
        extra: Option<Value>,
        timeout_secs: Option<u64>,
    ) -> Result<String> {
        if key.is_empty() {
            return Err(anyhow!("未配置 LLM_API_KEY：请在项目根目录的 .env 里填写后重启"));
        }
        let mut body = json!({
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        });
        if let (Some(extra), Some(fields)) = (extra, body.as_object_mut()) {
            if let Value::Object(extra) = extra {
                for (name, value) in extra {
                    fields.insert(name, value);
                }
            }
        }
        let mut request = self
            .http
            .post(format!("{base}/chat/completions"))
            .bearer_auth(key)
            .json(&body);
        if let Some(secs) = timeout_secs {
            request = request.timeout(Duration::from_secs(secs));
        }
        let resp = request.send().await?;
        let status = resp.status();
        let text = resp.text().await?;
        if !status.is_success() {
            let brief: String = text.chars().take(300).collect();
            return Err(anyhow!("模型接口返回 {}：{}", status.as_u16(), brief));
        }
        let value: Value = serde_json::from_str(&text)?;
        let content = value["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_string();
        if content.is_empty() {
            let choice = &value["choices"][0];
            let reasoning = choice["message"]["reasoning_content"].as_str().unwrap_or("");
            let truncated = choice["finish_reason"].as_str() == Some("length");
            return Err(anyhow!(if truncated && !reasoning.is_empty() {
                "模型把 token 全花在思考（reasoning）上就截断了，没有输出正文：                 请把模型换成 deepseek-chat 这类非思考模型"
            } else if !reasoning.is_empty() {
                "模型只返回了思考内容、没有正文：请把模型换成 deepseek-chat 这类非思考模型"
            } else {
                "模型返回内容为空"
            }));
        }
        Ok(content)
    }

    /// 为一段学习材料出考点（摘要 / 要点 / 考题 / 答案）。
    pub async fn digest_unit(&self, title: &str, content: &str) -> Result<CardDigest> {
        let user = format!(
            "材料标题：{title}\n\n材料正文：\n{}",
            crate::ingest::truncate_chars(content, 12_000)
        );
        let messages = json!([
            { "role": "system", "content": DIGEST_SYSTEM },
            { "role": "user", "content": user },
        ]);
        let raw = self.chat(messages, &self.model, 2000, 0.3).await?;
        let json_text = extract_json(&raw, '{', '}')?;
        let digest: CardDigest = serde_json::from_str(&json_text)
            .map_err(|e| anyhow!("考点 JSON 解析失败：{e}"))?;
        Ok(digest)
    }

    /// 成书第一步：从素材清单里排出目录（章 + 每章引用的素材 key）。
    pub async fn book_outline(
        &self,
        title: &str,
        goal: &str,
        catalog: &[crate::book::Candidate],
    ) -> Result<Vec<OutlineChapter>> {
        let list = catalog
            .iter()
            .take(120)
            .map(|item| {
                let section = if item.section.trim().is_empty() { "未分类" } else { item.section.trim() };
                format!("- key={} （{}） {}", item.key, section, item.title)
            })
            .collect::<Vec<_>>()
            .join("\n");
        let user = format!(
            "书名：{title}\n学习目标：{}\n\n素材清单（共 {} 条）：\n{list}",
            if goal.trim().is_empty() { "未指定，按书名理解" } else { goal.trim() },
            catalog.len()
        );
        let messages = json!([
            { "role": "system", "content": BOOK_OUTLINE_SYSTEM },
            { "role": "user", "content": user },
        ]);
        let raw = self.chat(messages, &self.model, 3000, 0.3).await?;
        let json_text = extract_json(&raw, '[', ']')?;
        let items: Vec<OutlineChapter> = serde_json::from_str(&json_text)
            .map_err(|e| anyhow!("目录 JSON 解析失败：{e}"))?;

        // 模型偶尔会漏 key 或把同一条素材塞进两章：这里按素材清单收一遍。
        let valid: std::collections::HashSet<&str> =
            catalog.iter().map(|item| item.key.as_str()).collect();
        let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
        let chapters: Vec<OutlineChapter> = items
            .into_iter()
            .filter_map(|mut chapter| {
                chapter.keys.retain(|key| valid.contains(key.as_str()) && used.insert(key.clone()));
                if chapter.keys.is_empty() || chapter.title.trim().is_empty() {
                    return None;
                }
                chapter.title = chapter.title.trim().to_string();
                chapter.intro = chapter.intro.trim().to_string();
                Some(chapter)
            })
            .take(12)
            .collect();
        if chapters.is_empty() {
            return Err(anyhow!("模型没排出可用目录：换个书名，或换一批素材再试"));
        }
        Ok(chapters)
    }

    /// 成书第二步：写一章正文。素材只放本章引用的那几条，避免一次性塞爆上下文。
    pub async fn write_chapter(
        &self,
        book_title: &str,
        chapter_title: &str,
        intro: &str,
        sources: &[(String, String)],
        previous_tail: &str,
    ) -> Result<String> {
        let body = sources
            .iter()
            .map(|(title, content)| format!("【素材：{title}】\n{}", truncate(content, 3500)))
            .collect::<Vec<_>>()
            .join("\n\n---\n\n");
        let mut user = format!(
            "书名：{book_title}\n本章标题：{chapter_title}\n本章范围：{intro}\n\n素材原文：\n{body}"
        );
        if !previous_tail.trim().is_empty() {
            user.push_str(&format!(
                "\n\n上一章结尾（只用来衔接语气，不要重复它的内容）：\n{}",
                truncate(previous_tail, 600)
            ));
        }
        let messages = json!([
            { "role": "system", "content": BOOK_CHAPTER_SYSTEM },
            { "role": "user", "content": user },
        ]);
        let text = self.chat(messages, &self.model, 6000, 0.4).await?;
        let text = text.trim().to_string();
        if text.chars().count() < 120 {
            return Err(anyhow!("这一章只写了 {} 字，太短；稍后在书里点「继续生成」重试", text.chars().count()));
        }
        Ok(text)
    }

    /// 给一个知识点出题：一次调用出一组题（用户指定题型与分值）。
    pub async fn make_questions(
        &self,
        title: &str,
        content: &str,
        asks: &[(String, f64)],
    ) -> Result<Vec<PaperQuestion>> {
        let list = asks
            .iter()
            .map(|(kind, points)| format!("- {}（{} 分）", kind_label(kind), points))
            .collect::<Vec<_>>()
            .join("\n");
        let user = format!(
            "知识点标题：{title}\n\n知识点正文：\n{}\n\n请按下面这些要求出 {} 道题：\n{list}",
            crate::ingest::truncate_chars(content, 6000),
            asks.len()
        );
        let messages = json!([
            { "role": "system", "content": PAPER_SYSTEM },
            { "role": "user", "content": user },
        ]);
        let raw = self.chat(messages, &self.model, 3000, 0.4).await?;
        let json_text = extract_json(&raw, '[', ']')?;
        let items: Vec<PaperQuestion> = serde_json::from_str(&json_text)
            .map_err(|e| anyhow!("出题 JSON 解析失败：{e}"))?;
        Ok(items)
    }

    /// 主观题判分（客观题在本地判，不用模型）。
    pub async fn grade_exam_answer(
        &self,
        stem: &str,
        reference: &str,
        user_answer: &str,
        points: f64,
    ) -> Result<ItemGrade> {
        let user = format!(
            "题干：{stem}\n\n参考答案：{reference}\n\n本题满分：{points}\n\n考生作答：\n{user_answer}"
        );
        let messages = json!([
            { "role": "system", "content": GRADE_ITEM_SYSTEM },
            { "role": "user", "content": user },
        ]);
        let raw = self.chat(messages, &self.model, 1500, 0.2).await?;
        let json_text = extract_json(&raw, '{', '}')?;
        let mut grade: ItemGrade = serde_json::from_str(&json_text)
            .map_err(|e| anyhow!("判分 JSON 解析失败：{e}"))?;
        grade.score = grade.score.clamp(0.0, points);
        grade.verdict = match grade.verdict.as_str() {
            "correct" | "partial" | "wrong" => grade.verdict.clone(),
            _ if grade.score >= points * 0.99 => "correct".to_string(),
            _ if grade.score <= 0.0 => "wrong".to_string(),
            _ => "partial".to_string(),
        };
        Ok(grade)
    }

    /// 把抓来的原始文本整理成干净材料（智能导入的默认路径）。返回 Markdown 正文。
    pub async fn extract_material(&self, origin: &str, section_hint: &str, raw: &str) -> Result<String> {
        let user = format!(
            "来源：{origin}\n位置：{section_hint}\n\n原始文本：\n{raw}"
        );
        let messages = json!([
            { "role": "system", "content": EXTRACT_SYSTEM },
            { "role": "user", "content": user },
        ]);
        let text = self.chat(messages, &self.model, 8000, 0.2).await?;
        Ok(text.trim().to_string())
    }

    pub async fn grade(&self, question: &str, reference: &str, user_answer: &str) -> Result<GradeResult> {
        let user = format!(
            "题目：{}\n\n参考答案：{}\n\n面试者的回答：{}",
            question,
            truncate(reference, 4000),
            user_answer
        );
        let messages = json!([
            { "role": "system", "content": GRADE_SYSTEM },
            { "role": "user", "content": user },
        ]);
        let raw = self.chat(messages, &self.model, 1500, 0.2).await?;
        let json_text = extract_json(&raw, '{', '}')?;
        let mut result: GradeResult = serde_json::from_str(&json_text)
            .map_err(|e| anyhow!("模型输出的评分 JSON 解析失败：{e}"))?;
        result.score = result.score.clamp(0.0, 10.0);
        Ok(result)
    }
}

/// 题型的展示名，出题提示词与界面共用。
pub fn kind_label(kind: &str) -> &'static str {
    match kind {
        "single" => "单选题",
        "multi" => "多选题",
        "judge" => "判断题",
        "blank" => "填空题",
        "short" => "简答题",
        "case" => "案例题",
        _ => "题目",
    }
}

/// 成书目录里的章：标题、导语、引用的素材 key。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineChapter {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub intro: String,
    #[serde(default)]
    pub keys: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperQuestion {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub stem: String,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub answer: String,
    #[serde(default)]
    pub explain: String,
    #[serde(default)]
    pub points: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemGrade {
    #[serde(default)]
    pub score: f64,
    #[serde(default)]
    pub verdict: String,
    #[serde(default)]
    pub feedback: String,
    #[serde(default)]
    pub missed: Vec<String>,
    #[serde(default)]
    pub suggestion: String,
}

/// 从模型输出里截出 JSON（容忍代码块围栏与前后解释）。
pub fn extract_json(raw: &str, open: char, close: char) -> Result<String> {
    let start = raw.find(open).ok_or_else(|| anyhow!("模型输出里找不到 JSON"))?;
    let end = raw.rfind(close).ok_or_else(|| anyhow!("模型输出的 JSON 不完整"))?;
    if end <= start {
        return Err(anyhow!("模型输出的 JSON 结构异常"));
    }
    Ok(raw[start..=end].to_string())
}

/// 拼问答的多轮消息：段落只在第一条里带一次，历史最多回放 6 轮，省 token。
pub fn ask_messages(title: &str, passage: &str, question: &str, history: &[AskTurn]) -> Value {
    let mut messages = vec![json!({ "role": "system", "content": ASK_SYSTEM })];
    let mut first = true;
    let start = history.len().saturating_sub(6);
    for turn in &history[start..] {
        let content = if first {
            format!(
                "单元：{title}\n\n选中段落：\n{}\n\n我的问题：{}",
                truncate(passage, 1500),
                turn.question
            )
        } else {
            turn.question.clone()
        };
        messages.push(json!({ "role": "user", "content": content }));
        messages.push(json!({ "role": "assistant", "content": turn.answer }));
        first = false;
    }
    let last = if first {
        format!(
            "单元：{title}\n\n选中段落：\n{}\n\n我的问题：{question}",
            truncate(passage, 1500)
        )
    } else {
        question.to_string()
    };
    messages.push(json!({ "role": "user", "content": last }));
    Value::Array(messages)
}

/// 接口是否因为不认识 `thinking` 字段而拒绝：是的话就去掉它重试。
fn rejects_thinking(error: &anyhow::Error) -> bool {
    let text = error.to_string().to_lowercase();
    ["thinking", "unknown field", "unrecognized", "unknown parameter", "extra field"]
        .iter()
        .any(|needle| text.contains(needle))
}

pub fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let cut: String = text.chars().take(max_chars).collect();
    format!("{cut}\n…（后文因长度截断）")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_json_from_fenced_output() {
        let fence = "\u{0060}\u{0060}\u{0060}";
        let raw = format!("好的，结果如下：\n{fence}json\n[{{\"title\":\"A\"}}]\n{fence}\n希望有帮助");
        let got = extract_json(&raw, '[', ']').unwrap();
        assert_eq!(got, "[{\"title\":\"A\"}]");
    }

    #[test]
    fn ask_messages_put_passage_in_first_turn_only() {
        let history = vec![
            AskTurn { question: "q1".into(), answer: "a1".into() },
            AskTurn { question: "q2".into(), answer: "a2".into() },
        ];
        let messages = ask_messages("标题", "段落正文", "追问", &history);
        let text = messages.to_string();
        assert_eq!(text.matches("段落正文").count(), 1);
        assert!(text.contains("q1") && text.contains("a2"));
        assert!(messages.as_array().unwrap().last().unwrap()["content"]
            .as_str()
            .unwrap()
            .contains("追问"));
    }

    #[test]
    fn ask_messages_keeps_only_six_history_turns() {
        let history: Vec<AskTurn> = (0..8)
            .map(|i| AskTurn { question: format!("q{i}"), answer: format!("a{i}") })
            .collect();
        let text = ask_messages("t", "p", "last", &history).to_string();
        assert!(!text.contains("q0") && !text.contains("q1"));
        assert!(text.contains("q2") && text.contains("q7"));
    }

    #[test]
    fn thinking_param_rejection_is_detected() {
        let rejected = anyhow!("模型接口返回 400：{{\"error\":{{\"message\":\"Unrecognized request argument: thinking\"}}}}");
        assert!(rejects_thinking(&rejected));
        let timeout = anyhow!("请求超时");
        assert!(!rejects_thinking(&timeout));
    }

    #[test]
    fn truncate_keeps_char_boundaries() {
        let s = "中文abc";
        assert_eq!(truncate(s, 10), s);
        assert!(truncate(s, 2).starts_with("中文"));
    }
}