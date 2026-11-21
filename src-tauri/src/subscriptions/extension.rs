use crate::AirResult;
use serde::{Deserialize, Serialize};
use serde_yaml::Value;
use std::time::{Duration, Instant};

#[derive(Default, Deserialize, Serialize, PartialEq)]
pub struct Extension {
    pub script: String,
    pub rules: Vec<String>,
}

impl Extension {
    pub fn empty(&self) -> bool {
        self.script.trim().is_empty() && self.rules.is_empty()
    }

    pub fn render(&self, yaml: &str) -> AirResult<String> {
        let mut config: Value = serde_yaml::from_str(yaml).map_err(|_| "订阅 YAML 无效")?;
        if !self.script.trim().is_empty() {
            let json = serde_json::to_string(&config).map_err(|_| "订阅不能转换为脚本配置")?;
            let rt = rquickjs::Runtime::new().map_err(|_| "无法创建扩展脚本环境")?;
            rt.set_memory_limit(64 * 1024 * 1024);
            rt.set_max_stack_size(512 * 1024);
            let deadline = Instant::now() + Duration::from_secs(1);
            rt.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));
            let ctx = rquickjs::Context::full(&rt).map_err(|_| "无法初始化扩展脚本")?;
            let result = ctx
                .with(|ctx| {
                    ctx.globals().set("__airInput", json)?;
                    ctx.eval::<String, _>(format!(
                        "{}\n;JSON.stringify(main(JSON.parse(__airInput)))",
                        self.script
                    ))
                })
                .map_err(|_| {
                    "扩展脚本执行失败，请检查 main(config) 的返回值、执行时间或内存用量"
                })?;
            config = serde_json::from_str(&result).map_err(|_| "扩展脚本必须返回配置对象")?;
        }
        if !config.is_mapping() {
            return Err("扩展脚本必须返回配置对象".into());
        }
        if !self.rules.is_empty() {
            if self
                .rules
                .iter()
                .any(|rule| rule.trim().split(',').count() < 2)
            {
                return Err("附加规则格式无效".into());
            }
            let mut rules: Vec<_> = self
                .rules
                .iter()
                .map(|s| Value::String(s.trim().to_owned()))
                .collect();
            if let Some(original) = config["rules"].as_sequence() {
                rules.extend(original.iter().cloned());
            }
            config["rules"] = Value::Sequence(rules);
        }
        let rendered = serde_yaml::to_string(&config).map_err(|_| "扩展配置无法保存")?;
        super::parse(String::new(), String::new(), &rendered)?;
        Ok(rendered)
    }
}
