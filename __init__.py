from .bbox_edit import (
    NODE_CLASS as BBOX_NODE_CLASS,
    NODE_DISPLAY_NAME as BBOX_NODE_DISPLAY_NAME,
    JosiaBBoxEdit,
)
from .qwen_accel import (
    KINDS,
    NODE_CLASS,
    NODE_DISPLAY_NAME,
    JosiaQwenAccel,
    list_lora_files,
)

NODE_CLASS_MAPPINGS = {
    NODE_CLASS: JosiaQwenAccel,
    BBOX_NODE_CLASS: JosiaBBoxEdit,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_CLASS: NODE_DISPLAY_NAME,
    BBOX_NODE_CLASS: BBOX_NODE_DISPLAY_NAME,
}

# ComfyUI 只认这个常量名（load_custom_node 里 module.WEB_DIRECTORY），
# 写成别的名字前端 JS 就不会被挂载，联动整条线全部空转
WEB_DIRECTORY = "./web"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
    "KINDS",
    "list_lora_files",
    BBOX_NODE_CLASS,
]
