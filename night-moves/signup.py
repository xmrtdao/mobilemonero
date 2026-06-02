# XMRT DAO Mobile Mining Script — with XMRig API + unique worker tracking
# Installs XMRig on Termux with API enabled for fleet dashboard integration

import os
import sys
import time
import subprocess
import json
import hashlib
import random
from collections import OrderedDict

# ASCII Art and Branding
XMRT_ASCII = r"""
██╗  ██╗███╗   ███╗██████╗  ████████╗
╚██╗██╔╝████╗ ████║██╔══██╗ ╚══██╔══╝
 ╚███╔╝ ██╔████╔██║██████╔╝    ██║
 ██╔██╗ ██║╚██╔╝██║██╔══██╗    ██║
██╔╝ ██╗██║ ╚═╝ ██║██║  ██║    ██║
╚═╝ ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝    ╚═╝
"""

TAGLINE = "D E C E N T R A L I Z E D   A U T O N O M O U S   O R G A N I Z A T I O N"

POOL_WALLET = "46UxNFuGM2E3UwmZWWJicaRPoRwqwW4byQkaTHkX8yPcVihp91qAVtSFipWUGJJUyTXgzSqxzDQtNLf2bsp2DX2qCCgC5mg"

def colorful_print(text, color_code):
    """Print colored text in Termux"""
    print(f"\033[{color_code}m{text}\033[0m")

def show_header():
    """Display branded welcome screen"""
    os.system('clear')
    # XMRT logo in orange/red
    colorful_print(XMRT_ASCII, "31")
    # Tagline in cyan
    colorful_print("\n" + TAGLINE + "\n", "36")
    # Divider line
    print("\033[34m" + "─" * 54 + "\033[0m")
    print()

def install_dependencies():
    """Install required Termux packages"""
    colorful_print("\n🔧 Setting up environment...", "35")
    packages = [
        "python", "clang", "nodejs", "openssl-tool",
        "git", "cmake", "make", "libuv", "libmicrohttpd"
    ]

    try:
        subprocess.run("apt update && apt upgrade -y",
                       shell=True, check=True)
        subprocess.run(f"apt install -y {' '.join(packages)}",
                       shell=True, check=True)
        colorful_print("✅ Environment setup complete!", "32")
    except subprocess.CalledProcessError as e:
        colorful_print(f"❌ Setup failed: {str(e)}", "31")
        sys.exit(1)

def generate_user_number(username):
    """Create unique user ID from username"""
    seed = f"{username}-{time.time()}-{random.randint(1000,9999)}"
    return hashlib.sha256(seed.encode()).hexdigest()[:8].upper()

def user_registration():
    """Collect user information and create config"""
    show_header()
    colorful_print("📝 DAO Membership Registration\n", "36")

    user_data = OrderedDict()
    default_alias = f"xmrt-{hashlib.sha256(str(time.time()).encode()).hexdigest()[:6]}"
    alias_input = input(f"Choose your mining alias [{default_alias}]: ").strip()
    user_data['username'] = alias_input if alias_input else default_alias
    user_data['user_number'] = generate_user_number(user_data['username'])
    user_data['timestamp'] = int(time.time())

    with open('xmrt_miner.json', 'w') as f:
        json.dump(user_data, f, indent=2)

    colorful_print(f"\n🎉 Account created! Your Miner ID: {user_data['user_number']}", "32")
    return user_data

def configure_miner(user_data):
    """Create XMRig configuration with API enabled for fleet tracking"""
    worker_name = user_data['username']
    worker_id = user_data['user_number']

    config = {
        "autosave": True,
        "cpu": True,
        "opencl": False,
        "cuda": False,
        "pools": [{
            "url": "pool.supportxmr.com:3333",
            "user": f"{POOL_WALLET}.{worker_id}",
            "pass": worker_name,
            "keepalive": True,
            "tls": False
        }],
        "api": {
            "id": worker_id,
            "worker-id": worker_name,
            "port": 19090,
            "access-token": None,
            "restricted": True
        },
        "http": {
            "enabled": True,
            "host": "127.0.0.1",
            "port": 19090,
            "access-token": None,
            "restricted": True
        }
    }

    with open('config.json', 'w') as f:
        json.dump(config, f, indent=2)
    colorful_print("📄 Miner configuration generated with fleet API enabled", "34")
    colorful_print(f"   Worker name: {worker_name}", "35")
    colorful_print(f"   Worker ID:   {worker_id}", "35")
    colorful_print(f"   API port:    19090", "35")

def install_miner():
    """Install and build XMRig with existence check"""
    colorful_print("\n⛏️ Installing XMRig miner...", "33")
    try:
        if not os.path.exists("xmrig"):
            subprocess.run("git clone https://github.com/xmrig/xmrig.git",
                           shell=True, check=True)
        else:
            colorful_print("⚠️ Using existing XMRig repository", "33")

        os.chdir("xmrig")

        if not os.path.exists("build/xmrig"):
            subprocess.run(
                "mkdir -p build && cd build && "
                "cmake .. -DWITH_HWLOC=OFF -DWITH_OPENCL=OFF -DWITH_CUDA=OFF && "
                "make -j$(nproc)",
                shell=True, check=True
            )
            colorful_print("✅ Miner installation complete!", "32")
        else:
            colorful_print("⚠️ Using existing XMRig build", "33")

    except subprocess.CalledProcessError as e:
        colorful_print(f"❌ Installation failed: {str(e)}", "31")
        sys.exit(1)
    finally:
        os.chdir("..")

def show_instructions(user_data):
    """Display post-install instructions"""
    show_header()
    colorful_print("🚀 Setup Complete! Here's How to Mine:", "36")
    print("\n1. Start mining:")
    colorful_print("   cd xmrig/build && ./xmrig -c ../../config.json", "33")

    print("\n2. Check your miner status (local):")
    colorful_print("   curl http://127.0.0.1:19090/1/summary", "35")

    print("\n3. Track your rewards on the fleet dashboard:")
    colorful_print("   https://relay.mobilemonero.com", "34")

    print("\n4. Your Fleet Identity:")
    colorful_print(f"   Worker Name: {user_data['username']}", "35")
    colorful_print(f"   Worker ID:   {user_data['user_number']}", "35")

    print("\n5. To auto-start on boot, add to ~/.bashrc:")
    colorful_print('   echo "cd ~/mobile-monero && ./xmrig/build/xmrig -c config.json &" >> ~/.bashrc', "33")

def main():
    show_header()
    colorful_print("This script will:", "33")
    print("- Install required packages")
    print("- Create your miner identity")
    print("- Configure XMRig with fleet API (port 19090)")
    print("- Set up automatic rewards tracking on the DAO dashboard\n")

    input("Press ENTER to begin setup...")

    install_dependencies()
    user_data = user_registration()
    configure_miner(user_data)
    install_miner()
    show_instructions(user_data)

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        colorful_print("\n🚫 Setup canceled by user", "31")
        sys.exit(0)
