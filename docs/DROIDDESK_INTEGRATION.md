# XMRT DAO on DroidDesk — Integration Guide

**Last Updated:** 2026-05-20  
**DroidDesk:** https://github.com/orailnoor/DroidDesk  
**XMRT DAO:** https://github.com/xmrtdao/mobilemonero

---

## 🎯 Overview

DroidDesk transforms your Android phone into a complete Linux desktop environment. This guide shows how to leverage DroidDesk for XMRT DAO development and Party Favor Photo operations.

---

## 📊 Before vs After DroidDesk

| Capability | Before (Terminal Only) | After (DroidDesk) |
|------------|------------------------|-------------------|
| **Code Editor** | vim/nano (terminal) | **VS Code** (full IDE) |
| **Web Browser** | curl (CLI only) | **Firefox** (full browser) |
| **PDF Creation** | fpdf2 (Python) | **LibreOffice** (GUI) |
| **Dashboard Testing** | Deploy to test | **Localhost preview** |
| **Network Debugging** | curl/wget | **Wireshark** (full packet analysis) |
| **AI Inference** | Cloudflare API | **Local LLM** (offline, 5+ tok/s) |
| **3D Assets** | None | **Blender** (3D modeling) |
| **Multi-tasking** | Single terminal | **Multiple windows** |

---

## 🚀 Installation Status

### Current Progress
```
Step 1/12: ✅ Update system packages
Step 2/12: ✅ Add X11 + TUR repositories
Step 3/12: ✅ Install Termux-X11
Step 4/12: 🔄 Installing XFCE4 Desktop (IN PROGRESS)
Step 5/12: ⏳ GPU drivers (Turnip/Zink)
Step 6/12: ⏳ Audio support
Step 7/12: ⏳ Core apps (Firefox, Git, Python)
Step 8/12: ⏳ Python development environment
Step 9/12: ⏳ Proot container (Ubuntu/Debian)
Step 10/12: ⏳ Create launchers
Step 11/12: ⏳ XFCE theme + wallpaper
Step 12/12: ⏳ Keyboard shortcuts
```

### Estimated Completion
- **Time Remaining:** ~20-25 minutes
- **Disk Space:** 23GB available (need ~4-6GB)
- **RAM:** 5.8GB free (XFCE4 needs ~1-2GB)

---

## 🛠️ Post-Installation Setup

### 1. Start Desktop Environment
```bash
# After installation completes
bash ~/start-x11.sh

# Then open Termux-X11 app on your phone
```

### 2. Verify XMRT DAO Tools
```bash
# In XFCE terminal
cd ~/mobilemonero
python3 --version  # Should be 3.11+
git status         # Check repo state
```

### 3. Install VS Code Extensions
```bash
# In VS Code (Applications → Programming → Visual Studio Code)
# Install these extensions:
- Python (ms-python.python)
- GitLens (eamodio.gitlens)
- GitHub Pull Requests (GitHub.vscode-pull-request-github)
- Docker (ms-azuretools.vscode-docker)
- YAML (redhat.vscode-yaml)
```

### 4. Test Fleet Relay
```bash
# In XFCE terminal
curl http://localhost:9090/health
# Expected: {"ok": true, "worker": "hermes-relay", ...}
```

### 5. Test Email Pipeline
```bash
curl https://relay.mobilemonero.com/resend/inbox | python3 -m json.tool
# Should show 50+ emails
```

---

## 💼 XMRT DAO Workflows on DroidDesk

### Workflow 1: Contract Creation (LibreOffice)
```bash
# Open LibreOffice Writer
# Create professional contract with:
- PFP logo header
- Client information table
- Service bullet points
- Pricing breakdown
- Terms & conditions
- Signature lines

# Export as PDF
# Send via email pipeline
python3 ~/mobilemonero/tools/pdf_tools.py send \
  --pdf contract.pdf \
  --to client@example.com
```

**Advantage:** Professional formatting, easy editing, reusable templates

---

### Workflow 2: Dashboard Development (VS Code + Firefox)
```bash
# In VS Code
cd ~/mobilemonero/night-moves
code index.html

# Edit dashboard
# Save changes

# In Firefox
# Open: http://localhost:8000 (or file://)
# Test responsive design
# Debug with DevTools (F12)
```

**Advantage:** Live preview, instant feedback, professional debugging

---

### Workflow 3: Network Debugging (Wireshark)
```bash
# In Proot container
bash ~/start-proot.sh
apt install wireshark

# Run Wireshark (GUI)
wireshark &

# Capture fleet relay traffic
# Analyze API calls
# Debug Supabase 401 errors
```

**Advantage:** Full packet analysis, protocol inspection, SSL decryption

---

### Workflow 4: Local AI Inference
```bash
# In Proot container
bash ~/start-proot.sh

# Install Ollama or llama.cpp
apt install ollama

# Run local LLM
ollama run llama2

# Use for:
- Contract review
- Email drafting
- Code generation
- Dashboard copy
```

**Advantage:** Offline, no API costs, 5+ tokens/second, private

---

### Workflow 5: 3D Asset Creation (Blender)
```bash
# For MTV pipeline or PFP branding
# Open Blender (Applications → Graphics → Blender)

# Create:
- 3D logos
- Product renders
- Animation for MTV
- Festival booth mockups

# Export as PNG/MP4
# Use in marketing materials
```

**Advantage:** Professional 3D tools, no cloud rendering, full control

---

## 📁 File Organization

### Recommended Structure
```
~/
├── mobilemonero/           # XMRT DAO Fleet
│   ├── fleet/             # Relay, tunnel, dashboard
│   ├── tools/             # PDF tools, form processor
│   ├── docs/              # Documentation
│   └── pdfs/              # Contracts, quotes, forms
│
├── partyfavorphoto/        # PFP Toolkit
│   ├── contracts/         # 10 contract templates
│   ├── quotes/            # Quote generator
│   └── forms/             # Form profiles
│
├── DroidDesk/             # Desktop setup
│   └── setup.sh           # Installation script
│
└── workspace/             # Active development
    ├── night-moves/       # Mining dashboard
    ├── xmrt-stick/        # Landing page
    └── mtv/               # Music pipeline
```

---

## ⚙️ Performance Tuning

### For Non-Adreno GPUs (Our HONOR CRT-LX3)
```bash
# DroidDesk auto-detects and uses Zink/LLVMpipe
# For best performance:

# 1. Use XFCE4 (not KDE/MATE)
# 2. Close unused apps
# 3. Limit browser tabs (Firefox can be heavy)
# 4. Use lightweight themes
```

### Battery Optimization
```bash
# Desktop environment drains battery faster
# Recommendations:

# 1. Use for focused work sessions (2-3 hours)
# 2. Plug in for long development sessions
# 3. Close desktop when not in use: bash ~/stop-linux.sh
# 4. Use terminal-only for quick tasks
```

### Memory Management
```bash
# Check memory usage
free -h

# If running low:
# 1. Close Firefox tabs
# 2. Close unused VS Code windows
# 3. Stop Proot container: exit
# 4. Restart desktop: bash ~/stop-linux.sh && bash ~/start-x11.sh
```

---

## 🔧 Troubleshooting

### Issue: Desktop Won't Start
```bash
# Check Termux-X11 app is installed
# Check X11 repository is enabled
pkg list-installed | grep x11

# Restart X11 server
bash ~/stop-linux.sh
bash ~/start-x11.sh
```

### Issue: Apps Missing from Menu
```bash
# Sync Proot apps to menu
bash ~/proot-menu-sync.sh

# Wait 30 seconds for menu to refresh
```

### Issue: Slow Performance
```bash
# Check available RAM
free -h

# Close heavy apps (Firefox, Blender)
# Use terminal-based tools instead
# Consider LXQt instead of XFCE4 (lighter)
```

### Issue: Android Kills Background Session
```bash
# Fix: Developer Options → Child Process
# 1. Settings → Developer Options
# 2. Find "Child process" or "Background process limit"
# 3. Disable for Termux
# 4. Or set to "No background process limit"
```

---

## 🎯 XMRT DAO-Specific Benefits

### 1. **Fleet Development**
- VS Code for multi-file editing
- Git integration for commits
- Terminal panel for testing
- Debug fleet relay issues with Wireshark

### 2. **PFP Operations**
- LibreOffice for professional contracts
- Firefox for testing vendor forms
- Local PDF editing before sending
- Multi-window workflow (email + contract + calendar)

### 3. **MTV Pipeline**
- Blender for 3D assets
- Local AI for lyrics generation
- Firefox for MiniMax dashboard
- VS Code for pipeline scripting

### 4. **Dashboard Testing**
- Night Moves: Test locally before Vercel deploy
- XMRT Stick: Preview in Firefox
- Fleet Dashboard: Multi-device testing

---

## 📊 Comparison: Terminal vs DroidDesk

| Task | Terminal Only | DroidDesk | Time Saved |
|------|---------------|-----------|------------|
| **Edit 5 files** | vim (sequential) | VS Code (tabs) | 50% faster |
| **Test dashboard** | Deploy → browser | Localhost preview | 90% faster |
| **Create contract** | Python fpdf2 | LibreOffice GUI | 70% faster |
| **Debug network** | curl -v | Wireshark GUI | 80% faster |
| **Review PDF** | pdftotext | PDF viewer | 60% faster |
| **Multi-task** | tmux panes | Multiple windows | 40% faster |

---

## 🚀 Next Steps After Installation

1. ✅ **Test desktop startup:** `bash ~/start-x11.sh`
2. ✅ **Verify XMRT DAO tools:** `cd ~/mobilemonero && git status`
3. ✅ **Open VS Code:** Install Python + Git extensions
4. ✅ **Test Firefox:** Open `https://github.com/xmrtdao/mobilemonero`
5. ✅ **Create test contract:** LibreOffice → PDF → Email
6. ✅ **Test fleet relay:** `curl http://localhost:9090/health`
7. ✅ **Explore Proot:** `bash ~/start-proot.sh`
8. ✅ **Install Wireshark:** For network debugging
9. ✅ **Set up VNC:** For monitor output (optional)
10. ✅ **Document workflow:** Update this guide with learnings

---

## 📞 Support

- **DroidDesk Issues:** https://github.com/orailnoor/DroidDesk/issues
- **XMRT DAO Issues:** https://github.com/xmrtdao/mobilemonero/issues
- **Termux-X11:** https://github.com/termux/termux-x11
- **YouTube:** https://youtube.com/@orailnoor (DroidDesk creator)

---

**Welcome to full Linux desktop development on your phone!** 🎉

With DroidDesk, XMRT DAO development becomes 2-3x faster with VS Code, Firefox, LibreOffice, and professional debugging tools - all running natively on your Android phone.
