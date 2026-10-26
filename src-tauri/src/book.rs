//! 成书：把材料（或现搜的网络资料）编排成一本有目录、有正文的书。

use anyhow::Result;
use serde::Serialize;

use crate::ingest::{self, Ingested};
use crate::llm::OutlineChapter;
use crate::store::{Book, BookChapter, Card, NewCard, Store};

/// 待编排的一条素材。key 固定写成 `c:<cards.id>`，回到卡片就能取全文。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub key: String,
    pub section: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outline {
    pub chapters: Vec<OutlineChapter>,
    /// 素材来源说明，直接显示给用户
    pub origin: String,
    /// 网络取料时新建的材料 id：界面据此说明「已存为材料」
    pub material_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub written: i64,
    pub remaining: i64,
    pub done: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    pub book: Book,
    pub chapters: Vec<BookChapter>,
}

/// 候选素材。material_ids 为空表示全部材料。
/// 正文太短的卡片排不出章节，先挡掉。
pub fn candidates(store: &Store, material_ids: &[i64]) -> Result<Vec<Candidate>> {
    Ok(store
        .list_cards(None)?
        .into_iter()
        .filter(|card| card.content.trim().chars().count() >= 80)
        .filter(|card| material_ids.is_empty() || material_ids.contains(&card.material_id))
        .map(|card| Candidate {
            key: format!("c:{}", card.id),
            section: card.section,
            title: card.title,
        })
        .collect())
}

/// 网络取到的内容落库：顺手变成一份材料，成完书还能在「材料」页继续学。
pub fn save_topic(store: &Store, item: &Ingested, now: &str, today: &str) -> Result<i64> {
    let id = store.insert_material(&item.title, &item.source, &item.kind, item.chars, &item.text, now)?;
    let units = ingest::split_units(&item.text, &item.kind);
    let cards: Vec<NewCard> = units
        .iter()
        .map(|unit| NewCard {
            section: unit.section.clone(),
            title: unit.title.clone(),
            content: unit.content.clone(),
            ..Default::default()
        })
        .collect();
    store.insert_cards(id, &cards, today)?;
    Ok(id)
}

/// 把本章引用的 key 换成（标题, 正文）。
pub fn sources(cards: &[Card], keys: &[String]) -> Vec<(String, String)> {
    keys.iter()
        .filter_map(|key| {
            let id = key.strip_prefix("c:")?.parse::<i64>().ok()?;
            cards
                .iter()
                .find(|card| card.id == id)
                .map(|card| (card.title.clone(), card.content.clone()))
        })
        .collect()
}

/// 上一章结尾：下一章写的时候用来衔接语气。
pub fn tail(text: &str) -> String {
    let count = text.chars().count();
    if count <= 500 {
        return text.to_string();
    }
    text.chars().skip(count - 500).collect()
}

pub fn export_markdown(book: &Book, chapters: &[BookChapter]) -> String {
    let mut out = format!("# {}\n\n", book.title);
    if !book.goal.trim().is_empty() {
        out.push_str(&format!("> {}\n\n", book.goal.trim()));
    }
    out.push_str(&format!("> 素材：{}\n\n---\n\n", book.origin));
    for chapter in chapters {
        out.push_str(&format!("## 第 {} 章 {}\n\n", chapter.seq, chapter.title));
        if !chapter.intro.trim().is_empty() {
            out.push_str(&format!("_{}_\n\n", chapter.intro.trim()));
        }
        out.push_str(chapter.body.trim());
        out.push_str("\n\n");
    }
    out
}
