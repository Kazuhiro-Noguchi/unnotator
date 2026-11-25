//! コマンドの値の検査。JSON は「読めること」と、必要な形（オブジェクトなど）だけを確かめ、再整形はしない（research.md R3）。

use serde_json::Value;

use crate::error::StoreError;

fn invalid(message: String) -> StoreError {
    StoreError::InvalidCommand(message)
}

fn parse(field: &str, text: &str) -> Result<Value, StoreError> {
    serde_json::from_str(text)
        .map_err(|error| invalid(format!("{field} が JSON として読めない: {error}")))
}

/// JSON として読めること。
pub fn json_text(field: &str, text: &str) -> Result<(), StoreError> {
    parse(field, text).map(|_| ())
}

/// JSON のオブジェクトであること。
pub fn json_object(field: &str, text: &str) -> Result<(), StoreError> {
    match parse(field, text)? {
        Value::Object(_) => Ok(()),
        _ => Err(invalid(format!(
            "{field} は JSON のオブジェクトでなければならない"
        ))),
    }
}

/// `core/classification` の位置の指定は、空のオブジェクトでなければならない。
pub fn classification_selector(text: &str) -> Result<(), StoreError> {
    match parse("selector_json", text)? {
        Value::Object(map) if map.is_empty() => Ok(()),
        _ => Err(invalid(
            "core/classification の selector_json は空のオブジェクトでなければならない".to_owned(),
        )),
    }
}

const SCHEMA_KEYS: &[&str] = &["type", "title", "description", "properties", "required"];
const PROPERTY_KEYS: &[&str] = &["type", "enum", "default", "title", "description"];
const PROPERTY_TYPES: &[&str] = &["string", "number", "integer", "boolean"];

/// 属性スキーマの「形」が、JSON Schema のサブセットとして正しいこと。
/// 属性の値がスキーマに合うかは検査しない（拡張機能・画面側の責務）。
pub fn attribute_schema(text: &str) -> Result<(), StoreError> {
    let value = parse("schema_json", text)?;
    let Value::Object(schema) = value else {
        return Err(invalid(
            "schema_json は JSON のオブジェクトでなければならない".to_owned(),
        ));
    };
    if schema.get("type") != Some(&Value::String("object".to_owned())) {
        return Err(invalid(
            "schema_json の type は \"object\" でなければならない".to_owned(),
        ));
    }
    if let Some(key) = schema.keys().find(|k| !SCHEMA_KEYS.contains(&k.as_str())) {
        return Err(invalid(format!("schema_json に使えないキー: {key}")));
    }
    let empty = serde_json::Map::new();
    let properties = match schema.get("properties") {
        None => &empty,
        Some(Value::Object(map)) => map,
        Some(_) => {
            return Err(invalid(
                "properties はオブジェクトでなければならない".to_owned(),
            ));
        }
    };
    for (name, property) in properties {
        let Value::Object(property) = property else {
            return Err(invalid(format!(
                "属性 {name} の定義はオブジェクトでなければならない"
            )));
        };
        if let Some(key) = property
            .keys()
            .find(|k| !PROPERTY_KEYS.contains(&k.as_str()))
        {
            return Err(invalid(format!("属性 {name} に使えないキー: {key}")));
        }
        let has_enum = match property.get("enum") {
            None => false,
            Some(Value::Array(values)) if !values.is_empty() => true,
            Some(_) => {
                return Err(invalid(format!(
                    "属性 {name} の enum は空でない配列でなければならない"
                )));
            }
        };
        match property.get("type") {
            Some(Value::String(kind)) if PROPERTY_TYPES.contains(&kind.as_str()) => {}
            None if has_enum => {}
            _ => {
                return Err(invalid(format!(
                    "属性 {name} の型は string / number / integer / boolean / enum のどれかでなければならない"
                )));
            }
        }
    }
    match schema.get("required") {
        None => {}
        Some(Value::Array(names)) => {
            for required in names {
                let Some(required) = required.as_str() else {
                    return Err(invalid(
                        "required は文字列の配列でなければならない".to_owned(),
                    ));
                };
                if !properties.contains_key(required) {
                    return Err(invalid(format!(
                        "required の {required} が properties にない"
                    )));
                }
            }
        }
        Some(_) => return Err(invalid("required は配列でなければならない".to_owned())),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_text_accepts_valid_json_and_rejects_the_rest() {
        assert!(json_text("selector_json", "{ \"a\":  1 }").is_ok());
        assert!(json_text("selector_json", "[1, 2]").is_ok());
        assert!(json_text("selector_json", "null").is_ok());
        let err = json_text("selector_json", "{not json").unwrap_err();
        assert_eq!(err.code(), "invalid_command");
        assert!(err.to_string().contains("selector_json"));
        assert!(json_text("x", "").is_err());
    }

    #[test]
    fn json_object_requires_an_object() {
        assert!(json_object("attributes_json", "{}").is_ok());
        assert!(json_object("attributes_json", " { \"a\": 1 } ").is_ok());
        assert!(json_object("attributes_json", "[]").is_err());
        assert!(json_object("attributes_json", "1").is_err());
    }

    #[test]
    fn classification_selector_must_be_an_empty_object() {
        assert!(classification_selector("{}").is_ok());
        assert!(classification_selector(" {  } ").is_ok());
        assert!(classification_selector("{\"a\":1}").is_err());
        assert!(classification_selector("[]").is_err());
        assert!(classification_selector("nope").is_err());
    }

    #[test]
    fn attribute_schema_accepts_the_subset() {
        let schema = r#"{
            "type": "object",
            "title": "t",
            "description": "d",
            "properties": {
                "s": {"type": "string", "default": "x", "title": "S", "description": "d"},
                "n": {"type": "number"},
                "i": {"type": "integer", "default": 1},
                "b": {"type": "boolean"},
                "e": {"enum": ["a", "b"], "default": "a"},
                "e2": {"type": "string", "enum": ["a", "b"]}
            },
            "required": ["s", "e"]
        }"#;
        assert!(attribute_schema(schema).is_ok());
        assert!(attribute_schema(r#"{"type":"object","properties":{}}"#).is_ok());
    }

    #[test]
    fn attribute_schema_rejects_everything_outside_the_subset() {
        for bad in [
            "not json",
            "[]",
            r#"{"type":"array"}"#,
            r#"{"properties":{}}"#,
            r#"{"type":"object","properties":{"a":{"type":"object"}}}"#,
            r#"{"type":"object","properties":{"a":{"type":"string","pattern":"x"}}}"#,
            r#"{"type":"object","properties":{"a":{"enum":[]}}}"#,
            r#"{"type":"object","properties":{"a":{"title":"no type"}}}"#,
            r#"{"type":"object","properties":{"a":{"type":"string"}},"required":["b"]}"#,
            r#"{"type":"object","properties":{},"additionalProperties":false}"#,
        ] {
            assert!(attribute_schema(bad).is_err(), "{bad}");
        }
    }
}
