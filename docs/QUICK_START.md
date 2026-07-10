# Quick Start Guide: Model Leadership & Dynamic Fallbacks

Get up and running with intelligent model selection and automatic fallbacks in 5 minutes.

## 🚀 5-Minute Setup

### 1. Enable Model Leadership

Create or edit `~/.pi/agent/extensions/subagent/config.json`:

```json
{
  "modelLeadership": {
    "enabled": true,
    "preferences": {
      "preferFree": true,
      "defaultCategory": "coding",
      "maxResults": 50,
      "exclusionTTLMs": 86400000
    }
  }
}
```

### 2. Restart Your Session

The extension will automatically:
- Load the bundled offline snapshot (no API key required)
- Build the leadership rankings
- Enable dynamic cross-provider fallbacks

### 3. Verify It's Working

Run any subagent task. You should see fallback information in the status output:

```
✓ scout completed | attempts: gemini-2.5-flash → gpt-5-mini → claude-sonnet-4-5
```

---

## 🎯 Common Configurations

### Cost Optimization (Prefer Free Models)
```json
{
  "modelLeadership": {
    "enabled": true,
    "preferences": {
      "preferFree": true,
      "defaultCategory": "coding",
      "maxResults": 30,
      "paidSortRule": { "strategy": "cost" }
    }
  }
}
```

### Quality Focus (Best Available Models)
```json
{
  "modelLeadership": {
    "enabled": true,
    "preferences": {
      "preferFree": false,
      "defaultCategory": "coding",
      "maxResults": 50,
      "paidSortRule": { "strategy": "priority", "ratingDiffThreshold": 5 }
    }
  }
}
```

### Balanced (Smart Cost/Quality Trade-off)
```json
{
  "modelLeadership": {
    "enabled": true,
    "preferences": {
      "preferFree": true,
      "defaultCategory": "coding",
      "maxResults": 40,
      "paidSortRule": { "strategy": "rankedAndCost", "ratingDiffThreshold": 3 }
    }
  }
}
```

---

## 📋 What You Get

| Feature | Description |
|---------|-------------|
| **Ranked Model Selection** | Subagents automatically use the best-ranked model for their task category |
| **Automatic Fallbacks** | On any candidate failure, the next-ranked model is tried automatically; failed routes are remembered with retry hints and TTL |
| **Free Tier Preference** | When enabled, free models are tried first before paid alternatives |
| **Cross-Provider Routing** | Failures on one provider automatically route to another provider |
| **TTL-Based Recovery** | Failed routes are retried after 24 hours (configurable) |
| **Visible Fallback Chain** | Status shows exactly which models were attempted |

---

## 🔧 Essential Commands

| Command | Purpose |
|---------|---------|
| `/fetch-rankings` | Force-refresh rankings from llm-stats API (requires API key) |
| `/refresh-leadership` | Rebuild leadership from existing snapshot (offline) |
| `/subagents-models` | View available models and their rankings |

---

## 🐛 Troubleshooting

### "Model leadership not enabled"
Check that `modelLeadership.enabled` is `true` in your config.

### "No models available"
Run `/refresh-leadership` to rebuild from the offline snapshot, or `/fetch-rankings` if you have an API key.

### "Fallbacks not working"
1. Verify `exclusionTTLMs` is set (default: 86400000 = 24h)
2. Check `~/.pi/agent/model-exclusions.json` for active exclusions
3. Run `/refresh-leadership` to clear stale state

### "Want to use specific model"
Explicit `--model` flags bypass leadership. Use auto-mode (no `--model`) for ranked selection.

---

## 📚 Next Steps

- **Full Configuration Reference**: See [CONFIGURATION.md](CONFIGURATION.md)
- **Migration Guide**: Moving from static fallbacks? See [MIGRATION.md](MIGRATION.md)
- **Technical Details**: See [model-leadership.md](model-leadership.md)