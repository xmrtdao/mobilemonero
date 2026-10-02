
import yaml
import sys

config_path = r"C:\Users\PureTrek\AppData\Local\hermes\config.yaml"
try:
    with open(config_path, 'r') as f:
        config = yaml.safe_load(f)
    
    if config is None:
        config = {}
    if 'mcp_servers' not in config:
        config['mcp_servers'] = {}
    
    config['mcp_servers']['cua-driver'] = {
        'args': ['mcp'], 
        'command': r'C:\Users\PureTrek\AppData\Local\Programs\Cua\cua-driver\bin\cua-driver.exe', 
        'enabled': True
    }
    
    with open(config_path, 'w') as f:
        yaml.dump(config, f, default_flow_style=False)
    print("SUCCESS: Config patched")
except Exception as e:
    print(f"ERROR: {e}")
    sys.exit(1)

