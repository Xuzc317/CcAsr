# CcAsr 瀹夎璇存槑

## 鐜瑕佹眰

| 渚濊禆 | 鐗堟湰瑕佹眰 | 鐢ㄩ€?|
|------|----------|------|
| Python | 3.12+ | 鍚庣杩愯鏃?|
| Node.js | 20+ (LTS) | 鍓嶇鏋勫缓锛堣嚜甯?npm锛?|
| uv | 鏈€鏂扮増 | Python 渚濊禆绠＄悊 |
| ffmpeg | 鏈€鏂扮増 | 闊抽鏍煎紡杞爜 |

> 鍓嶇鍖呯鐞嗗櫒鐢?**npm**锛圢ode.js 鑷甫锛屾棤闇€棰濆瀹夎锛夈€?
> 浠撳簱鍐呴攣瀹氭枃浠朵负 `app/package-lock.json`銆?

**GPU 鍔犻€燂紙鍙€夛級锛?*

| 骞冲彴 | GPU | 璇存槑 |
|------|-----|------|
| macOS (Apple Silicon) | MPS | 鑷姩妫€娴嬶紝鏃犻渶棰濆閰嶇疆 |
| Windows/Linux (NVIDIA) | CUDA | 闇€瀹夎 CUDA 鐗?PyTorch锛堣涓嬫柟锛?|

## 1. 瀹夎鍩虹宸ュ叿

### Windows

```powershell
# ffmpeg锛堜换閫夊叾涓€锛?
winget install Gyan.FFmpeg
# 鎴?scoop install ffmpeg / choco install ffmpeg

# uv锛圥ython 渚濊禆绠＄悊锛?
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"

# Node.js锛堣嚜甯?npm锛屾棤闇€棰濆瀹夎锛?
winget install OpenJS.NodeJS.LTS
```

### macOS锛圚omebrew锛?

```bash
# Homebrew锛堝鏈畨瑁咃級
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# ffmpeg
brew install ffmpeg

# uv
curl -LsSf https://astral.sh/uv/install.sh | sh
source ~/.zshrc   # 閲嶆柊鍔犺浇 shell

# nvm + Node.js锛坣pm 闅忎箣瀹夎锛?
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.zshrc
nvm install --lts
nvm use --lts
```

## 2. 鑾峰彇浠ｇ爜

```bash
git clone git@github.com:Xuzc317/ASR.git CcAsr
cd CcAsr
```

## 3. 鍚庣瀹夎

```bash
uv sync
```

uv 浼氳嚜鍔ㄥ垱寤?`.venv` 骞跺畨瑁?Python 3.12 + 鎵€鏈変緷璧栥€?

楠岃瘉 GPU锛?

```bash
# Windows
.venv\Scripts\python.exe -c "import torch; print('CUDA:', torch.cuda.is_available())"
# macOS / Linux
.venv/bin/python -c "import torch; print('CUDA:', torch.cuda.is_available(), 'MPS:', hasattr(torch.backends,'mps') and torch.backends.mps.is_available())"
```

### Windows + NVIDIA GPU锛圕UDA 鍔犻€燂級

榛樿瀹夎鐨勬槸 CPU 鐗?PyTorch銆傚闇€ CUDA 鍔犻€燂細

```bash
cd CcAsr
.venv\Scripts\python.exe -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121
```

> 闇€瑕佸厛瀹夎 [NVIDIA CUDA Toolkit 12.1](https://developer.nvidia.com/cuda-12-1-0-download-archive) 鍜屽搴?cuDNN銆?

### macOS锛圡PS 鍔犻€燂級

macOS Apple Silicon 鑷姩浣跨敤 MPS锛屾棤闇€棰濆閰嶇疆銆?

## 4. 閰嶇疆鐜鍙橀噺锛圓I 鎬荤粨鍔熻兘锛?

AI 鎬荤粨鍔熻兘闇€瑕侀厤缃?LLM API銆傚鍒舵ā鏉垮苟濉啓锛?

```bash
cd CcAsr
cp .env.example .env     # Windows: copy .env.example .env
```

缂栬緫 `.env`锛?

```bash
# LLM API 閰嶇疆锛圤penAI 鍏煎鎺ュ彛锛?
CCASR_LLM_API_BASE=https://api.openai.com/v1    # API 鍦板潃
CCASR_LLM_API_KEY=sk-xxx                          # 浣犵殑 API Key
CCASR_LLM_MODEL=gpt-4o                            # 妯″瀷鍚嶇О
CCASR_LLM_MAX_CONTEXT=1000000                     # 鏈€澶т笂涓嬫枃闀垮害锛堝彲閫夛紝榛樿 1M锛?
```

- 鏀寔浠讳綍 OpenAI 鍏煎 API锛堝 DeepSeek銆丮oonshot銆佹湰鍦?Ollama 绛夛級
- `.env` **浠呭湪鍚庣鍚姩鏃跺姞杞?*锛屼慨鏀瑰悗蹇呴』閲嶅惎鏈嶅姟鎵嶇敓鏁?
- 濉ソ鍚庡彲璺戣繛閫氭€ц嚜妫€锛歚.venv\Scripts\python.exe backend\tests\check_llm_live.py`
- 涔熷彲闅忔椂鏌ョ湅 `GET /health` 鐨?`llm` 瀛楁锛屽畠浼氭寚鍑洪厤缃棶棰?

> 濡備笉闇€瑕佷細璁邯瑕佸姛鑳斤紝鍙烦杩囨姝ラ锛屼笉褰卞搷杞綍銆?
> 杞綍鏈韩**涓嶉渶瑕?* LLM銆?

## 5. 鍓嶇瀹夎

```bash
cd app
npm install
```

## 6. 鍚姩鏈嶅姟

Windows 鍙洿鎺ュ弻鍑?`start_backend.bat` / `start_frontend.bat`锛屾垨鎸変笅鏂囨墜鍔ㄥ惎鍔ㄣ€?

**缁堢 1 鈥?鍚庣锛堢鍙?8000锛夛細**

```bash
cd CcAsr
# Windows
.venv\Scripts\python.exe run_server.py
# macOS / Linux
.venv/bin/python run_server.py
```

**Debug 妯″紡**锛堣緭鍑鸿缁嗘棩蹇楋級锛?

```bash
# Windows
.venv\Scripts\python.exe run_server.py --debug
# macOS / Linux
.venv/bin/python run_server.py --debug
```

**缁堢 2 鈥?鍓嶇锛堢鍙?5173锛夛細**

```bash
cd CcAsr/app
npm run dev
```

鎵撳紑娴忚鍣ㄨ闂?`http://localhost:5173`銆?

## 7. 鏋勫缓鐢熶骇鐗堟湰

```bash
cd CcAsr/app
npm run build
```

鏋勫缓浜х墿杈撳嚭鍒?`app/dist/`锛屽悗绔?FastAPI 浼氳嚜鍔ㄦ墭绠★紙璁块棶 `http://localhost:8000`锛夈€?

## 鍐呯綉璁块棶

Vite 宸查厤缃?`host: true`锛屽墠绔嚜鍔ㄧ洃鍚?`0.0.0.0`銆傚眬鍩熺綉鍐呴€氳繃 `http://<鏈満IP>:5173` 璁块棶銆?

## 鏂囦欢绠＄悊

- 涓婁紶鏂囦欢瀛樺偍鍦?`~/CcAsr/output/files/`锛圵indows锛歚C:\Users\<浣?\CcAsr\output\files\`锛夛紝浠?MD5 鍝堝笇鍛藉悕锛堝幓閲嶏級
- 鍏冩暟鎹褰曞湪 `output/files/metadata.json`
- 鏂囦欢姘镐箙淇濆瓨锛屼笉浼氶殢浠诲姟娓呯悊鑰屽垹闄?
- 鍙敤 `CCASR_OUTPUT_DIR` 鑷畾涔夎緭鍑虹洰褰?

## 甯歌闂

### Q: `uv sync` 鎶?Python 鐗堟湰涓嶆弧瓒筹紵

uv 浼氳嚜鍔ㄤ笅杞?Python 3.12锛屾棤闇€鎵嬪姩瀹夎銆傚閬囬棶棰樺彲鎸囧畾鐗堟湰锛?

```bash
uv python install 3.12
uv sync
```

### Q: GPU 娌¤鐢ㄤ笂 / 濡備綍纭璁惧锛?

鍚庣 `/health` 鎺ュ彛鐨?`device` 瀛楁浼氭樉绀哄疄闄呬娇鐢ㄧ殑璁惧銆?

- 鏃犵嫭绔嬫樉鍗℃椂鑷姩鍥為€€ CPU锛屼娇鐢ㄥ鏍稿苟琛岋紙涓嶉渶瑕侀澶栭厤缃級
- NVIDIA 鏄惧崱闇€瑁?CUDA 鐗?PyTorch锛堣绗?3 鑺傦級
- MPS 浠?macOS Apple Silicon 鍙敤

### Q: 棣栨鍔犺浇妯″瀷寰堟參锛?

棣栨杩愯闇€涓嬭浇妯″瀷鏂囦欢锛垀1GB锛夛紝鍚庣画璧版湰鍦扮紦瀛樸€傚彲鎻愬墠鎵嬪姩涓嬭浇锛?

```bash
cd CcAsr
# Windows
.venv\Scripts\python.exe -c "from funasr import AutoModel; AutoModel(model='iic/SenseVoiceSmall')"
# macOS / Linux
.venv/bin/python -c "from funasr import AutoModel; AutoModel(model='iic/SenseVoiceSmall')"
```

### Q: 绔彛琚崰鐢紵

```bash
# macOS / Linux
lsof -ti:8000 && kill $(lsof -ti:8000)
```

```powershell
# Windows
Get-NetTCPConnection -LocalPort 8000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

### Q: 鍚庣閲嶅惎鍚庝换鍔″垪琛ㄤ负绌猴紵

浠诲姟鍒楄〃鎸佷箙鍖栧湪 `output/tasks.json`锛岄噸鍚悗浼氳嚜鍔ㄥ姞杞斤紱
杞啓缁撴灉锛坄output/*.json`锛夊拰闊抽鏂囦欢锛坄output/files/`锛夊悓鏍锋寔涔呬繚瀛樺湪纾佺洏涓娿€?

### Q: 淇敼 .env 鍚?AI 鎬荤粨涓嶇敓鏁堬紵

`.env` 鍦ㄥ悗绔惎鍔ㄦ椂鍔犺浇涓€娆★紝淇敼鍚庡繀椤婚噸鍚湇鍔★細

```bash
# 濡傛灉鐢?pm2
pm2 reload ccasr-backend

# 濡傛灉鎵嬪姩鍚姩锛氬厛 Ctrl+C 鍋滄锛屽啀閲嶆柊鍚姩
```

> Prompt 妯℃澘锛坄backend/prompts/*.md`锛夋敮鎸佺儹鏇存柊锛屼慨鏀瑰悗鏃犻渶閲嶅惎銆?
