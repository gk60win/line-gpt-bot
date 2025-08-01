
# LINE × ChatGPT 自動応答ボット（Node.js）

## 必要な設定

以下の環境変数を .env に記述してください：

- LINE_CHANNEL_ACCESS_TOKEN
- LINE_CHANNEL_SECRET
- OPENAI_API_KEY

## 実行方法（Render 用）

1. Render の New Web Service でこの zip をアップロード
2. Build Command: npm install
3. Start Command: node app.js
4. 環境変数を Render に設定
5. Webhook URL を LINE Developers に登録（例：https://your-service.onrender.com/webhook）

完了！
