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
from .media_hub import (
    HUB_NODE_CLASS,
    HUB_NODE_DISPLAY_NAME,
    SWITCH_NODE_CLASS,
    SWITCH_NODE_DISPLAY_NAME,
    JosiaMediaHub,
    JosiaMediaSwitchboard,
)

NODE_CLASS_MAPPINGS = {
    NODE_CLASS: JosiaQwenAccel,
    BBOX_NODE_CLASS: JosiaBBoxEdit,
    HUB_NODE_CLASS: JosiaMediaHub,
    SWITCH_NODE_CLASS: JosiaMediaSwitchboard,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_CLASS: NODE_DISPLAY_NAME,
    BBOX_NODE_CLASS: BBOX_NODE_DISPLAY_NAME,
    HUB_NODE_CLASS: HUB_NODE_DISPLAY_NAME,
    SWITCH_NODE_CLASS: SWITCH_NODE_DISPLAY_NAME,
}

# 归入节点库的「COMFY 节点」分区：前端按 ESSENTIALS_CATEGORY
# 将节点判为 Essentials，与 CATEGORY 分类字符串无关。
for _node_cls in NODE_CLASS_MAPPINGS.values():
    if not hasattr(_node_cls, "ESSENTIALS_CATEGORY"):
        _node_cls.ESSENTIALS_CATEGORY = "Basics"

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
    HUB_NODE_CLASS,
    SWITCH_NODE_CLASS,
]
