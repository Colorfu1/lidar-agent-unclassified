"""Generate experiment_tree.png with auto-layout (no hardcoded positions)."""
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch
import textwrap
import os
from pathlib import Path

# ── Apple-style palette ──────────────────────────────────────────────────────
BG        = '#f5f5f7'
WHITE     = '#ffffff'
GRAY_TEXT = '#86868b'
DARK      = '#1d1d1f'

C_ROOT  = ('#e8e8ed', '#6e6e73')
C_S1ROOT = ('#eceafc', '#6f5bd3')
C_0125  = ('#e8f4fd', '#007aff')
C_0301  = ('#f0e8fd', '#af52de')
C_0305  = ('#e8fdf0', '#34c759')
C_0310  = ('#fdf5e8', '#ff9500')
C_ERR   = ('#fde8e8', '#ff3b30')
C_FIX   = ('#e8fdee', '#30d158')

FONT = 'DejaVu Sans'

# ── Layout constants ─────────────────────────────────────────────────────────
NODE_W       = 3.2          # node box width
MIN_NODE_H   = 0.95         # minimum node height
LINE_H       = 0.22         # height per text line
BASE_H       = 0.50         # base padding inside node
GAP_Y        = 0.25         # vertical gap between nodes in a column
LABEL_H      = 0.45         # space reserved for subgraph label at top
PAD_X        = 0.25         # horizontal padding inside subgraph
PAD_Y        = 0.30         # vertical padding below bottom node
COL_GAP      = 0.6          # horizontal gap between columns
TITLE_FS     = 6.5          # title font size
SUB_FS       = 5.8          # subtitle font size
MAX_CHARS    = 38           # max chars per line before wrapping

# Keep directly related columns visually tight without changing the whole graph spacing.
COL_GAP_OVERRIDES = {
    (5, 6): 0.18,   # nn_nohem + weight -> downstream
    (6, 7): -0.18,  # keep #32 standalone but closer to its upstream #30
}


def compute_node_height(title, lines):
    """Compute the height a node needs based on its wrapped text."""
    title_lines = textwrap.fill(title, width=MAX_CHARS, break_long_words=True).split('\n')
    wrapped = []
    for ln in lines:
        wrapped.extend(textwrap.fill(ln, width=MAX_CHARS, break_long_words=True).split('\n'))
    total = len(title_lines) + len(wrapped)
    return max(MIN_NODE_H, BASE_H + total * LINE_H)


def draw_node(ax, cx, cy, w, h, fill, border, lw, title, lines, title_bold=True, node_id=None):
    """Draw a single node at (cx, cy) with given dimensions. Returns actual height."""
    title_lines = textwrap.fill(title, width=MAX_CHARS, break_long_words=True).split('\n')
    wrapped = []
    for ln in lines:
        wrapped.extend(textwrap.fill(ln, width=MAX_CHARS, break_long_words=True).split('\n'))

    box = FancyBboxPatch((cx - w/2, cy - h/2), w, h,
                         boxstyle='round,pad=0.06',
                         facecolor=fill, edgecolor=border,
                         linewidth=lw, zorder=3)
    if node_id is not None:
        box.set_gid(f"node-{node_id}")
    ax.add_patch(box)

    # Layout text top-down inside box
    total = len(title_lines) + len(wrapped)
    text_block_h = total * LINE_H
    top_text_y = cy + text_block_h / 2 - LINE_H / 2  # y of first line center

    y = top_text_y
    for tl in title_lines:
        ax.text(cx, y, tl, ha='center', va='center', fontsize=TITLE_FS,
                fontfamily=FONT, color=DARK,
                fontweight='bold' if title_bold else 'normal', zorder=4)
        y -= LINE_H
    for sl in wrapped:
        # Lines starting with "**" are rendered bold (marker stripped)
        if sl.startswith('**'):
            sl = sl[2:]
            ax.text(cx, y, sl, ha='center', va='center', fontsize=SUB_FS,
                    fontfamily=FONT, color='#3a3a3c', fontweight='bold', zorder=4)
        else:
            ax.text(cx, y, sl, ha='center', va='center', fontsize=SUB_FS,
                    fontfamily=FONT, color='#3a3a3c', zorder=4)
        y -= LINE_H

    return h


def layout_column(nodes_data, subgroup_breaks=None):
    """Given list of (title, lines, color), compute (cy, h) for each node stacked top-down.
    subgroup_breaks: set of node indices where a new subgroup starts.
      At these indices, extra space is inserted to guarantee no overlap between
      the previous subgroup's box (with PAD_Y below) and the new subgroup's
      box (with LABEL_H + PAD_Y above).
    Returns list of (cy, h) starting from y=0 downward."""
    result = []
    cursor_y = 0.0  # top of first node
    for i, (title, lines, _col) in enumerate(nodes_data):
        if subgroup_breaks and i in subgroup_breaks:
            # Auto-compute gap: previous subgroup box extends PAD_Y below last node.
            # New subgroup box needs LABEL_H + PAD_Y above first node.
            # Add a small visible gap without making related subgroups feel detached.
            auto_gap = PAD_Y + 0.18 + LABEL_H + PAD_Y
            cursor_y -= auto_gap
        h = compute_node_height(title, lines)
        cy = cursor_y - h / 2  # center y
        result.append((cy, h))
        cursor_y -= h + GAP_Y
    return result


def draw_subgraph(ax, cx, top_y, nodes_data, layouts, label, fill, border):
    """Draw the subgraph box around all laid-out nodes.
    top_y: if provided and lower than auto-computed top, use it as box top."""
    if not layouts:
        return
    top_node_top = layouts[0][0] + layouts[0][1] / 2
    bot_node_bot = layouts[-1][0] - layouts[-1][1] / 2
    box_top = top_node_top + PAD_Y + LABEL_H
    box_bot = bot_node_bot - PAD_Y
    box_h = box_top - box_bot
    box_w = NODE_W + PAD_X * 2
    box = FancyBboxPatch((cx - box_w/2, box_bot), box_w, box_h,
                         boxstyle='round,pad=0.0',
                         facecolor=fill, edgecolor=border,
                         linewidth=1.5, linestyle='--',
                         alpha=0.55, zorder=1)
    ax.add_patch(box)
    ax.text(cx, box_top - 0.15, label,
            ha='center', va='top', fontsize=8,
            fontfamily=FONT, color=border,
            fontweight='semibold', zorder=5)
    return box_top, box_bot


def compute_subgraph_bounds(layouts):
    """Return (top, bottom) bounds for a standard single-column subgraph."""
    top_node_top = layouts[0][0] + layouts[0][1] / 2
    bot_node_bot = layouts[-1][0] - layouts[-1][1] / 2
    return top_node_top + PAD_Y + LABEL_H, bot_node_bot - PAD_Y


def draw_span_subgraph(ax, nodes, label, fill, border):
    """Draw one subgraph box spanning multiple columns of nodes."""
    if not nodes:
        return
    left = min(cx - NODE_W / 2 for cx, _cy, _h in nodes) - PAD_X
    right = max(cx + NODE_W / 2 for cx, _cy, _h in nodes) + PAD_X
    top_node_top = max(cy + h / 2 for _cx, cy, h in nodes)
    bot_node_bot = min(cy - h / 2 for _cx, cy, h in nodes)
    box_top = top_node_top + PAD_Y + LABEL_H
    box_bot = bot_node_bot - PAD_Y
    box = FancyBboxPatch((left, box_bot), right - left, box_top - box_bot,
                         boxstyle='round,pad=0.0',
                         facecolor=fill, edgecolor=border,
                         linewidth=1.5, linestyle='--',
                         alpha=0.55, zorder=1)
    ax.add_patch(box)
    ax.text((left + right) / 2, box_top - 0.15, label,
            ha='center', va='top', fontsize=8,
            fontfamily=FONT, color=border,
            fontweight='semibold', zorder=5)
    return box_top, box_bot


ARROW_NORMAL  = dict(arrowstyle='->', lw=1.3, linestyle='solid')    # config change / progression
ARROW_DASHED  = dict(arrowstyle='->', lw=1.3, linestyle='dashed')   # variant (e.g., head change)
ARROW_INHERIT = dict(arrowstyle='-|>', lw=1.8, linestyle=(0, (4, 2)))  # load-from inheritance (thick dotted, filled head)

def arrow(ax, x0, y0, x1, y1, label='', dashed=False, color=DARK, rad=0.0,
          label_dx=0.0, label_dy=0.0, style_override=None):
    """Draw arrow with auto-positioned horizontal label.
    style_override: dict to override arrow style (use ARROW_INHERIT etc.)"""
    if style_override:
        props = {**style_override, 'color': color, 'connectionstyle': f'arc3,rad={rad}'}
    else:
        base = ARROW_DASHED if dashed else ARROW_NORMAL
        props = {**base, 'color': color, 'connectionstyle': f'arc3,rad={rad}'}
    ax.annotate('', xy=(x1, y1), xytext=(x0, y0),
                arrowprops=props, zorder=2)
    if label:
        mx, my = (x0+x1)/2, (y0+y1)/2
        # For curved arrows, shift label along the curve's bulge direction
        if rad != 0:
            mx += rad * abs(y1 - y0) * 0.5
            my -= rad * abs(x1 - x0) * 0.5
        # Place label above midpoint
        ax.text(mx + label_dx, my + 0.22 + label_dy, label,
                ha='center', va='bottom',
                fontsize=6.2, fontfamily=FONT, color=GRAY_TEXT, zorder=5)


# ══════════════════════════════════════════════════════════════════════════════
# DATA — each column is a list of (title, sub_lines, color)
# ══════════════════════════════════════════════════════════════════════════════
col_0125_data = [
    ('#1 flat_favs42_muon_qkclip_n_0125',
     ('ftn_0125ann · original', 'OD 0.731 · mIoU 0.650'), C_0125),
    ('#7 flat_favs42_muon_qkclip_ftn_0125_1105_0126_s4t100w_0226_h20_8w',
     ('ftn_0125ann_lossbug · ⚠ loss error', 'task: flat_favs42_muon_qkclip_ftn_0125_1105_0126_s4t100w_0226_h20_8w'), C_ERR),
    ('#11 flat_favs42_muon_qkclip_ftn_0125_1105_0126_s4t100w_0303_h20_8w',
     ('ftn_0125ann_lossfix · ✓ loss fixed',), C_FIX),
    ('#17 flat_favs42_muon_qkclip_nn_focal_0125ann_0227_pipe',
     ('nn_focal_0125ann',), C_0125),
]

col_0301_data = [
    ('#12 flat_favs42_muon_qkclip_ftn_0125_1105_0126_s4t100w_0303_0301ann_pipe',
     ('ftn_0301ann',), C_0301),
    ('#18 flat_favs42_muon_qkclip_nn_nohem_0301ann_0305',
     ('↳ ftn → nn_nohem',), C_0301),
    ('#16 flat_favs42_muon_qkclip_ftn_0125_1105_0126_s4t100w_160',
     ('↳ map label · s4t100w_160',), C_0301),
]

col_0305_data = [
    ('#13 flat_favs42_muon_qkclip_ftn_0125_1105_0126_s4t100w_0305_h20_8w',
     ('ftn_0305ann', 'task: flat_favs42_muon_qkclip_ftn_0125_1105_0126_s4t100w_0305_h20_8w_train-normal'), C_0305),
]

col_0310ig_data = [
    ('#14 flat_favs42_muon_qkclip_ftn_0125_1105_0126_s4t100w_0310ann_ignore_h20_8w_0310',
     ('ftn_0310_ignore · ● Running',), C_0310),
]

col_0310wo_data = [
    ('#15 flat_favs42_muon_qkclip_ftn_0125_1105_0126_s4t100w_0310ann_woignore_h20_8w_0310',
     ('ftn_0310_woignore · ● Running',), C_0310),
    ('#19 nn_focal_0310ann_free_8w_0314',
     ('↳ ftn → nn_focal',), C_0310),
    ('#20 nn_nohem_0310ann_free_8w_0314',
     ('↳ ftn → nn_nohem',), C_0310),
    ('#21 nn_nohem_st09_0310ann_free_8w_0314',
     ('↳ ftn → nn_nohem_st09', 'task: nn_nohem_st09_0310ann_free_8w_0314'), C_0310),
]

col_s1_data = [
    ('#33 s1_nn_nohem_0310ann_0318',
     ('nn_nohem_0310ann_s1_0318', 'pretrain: s1 retrain epoch_48', '● Submitted', 'task: s1_nn_nohem_0310ann_0318-train-normal'), C_S1ROOT),
    ('#34 s1_ftground_newohem_from_nn_nohem_0310_0319',
     ('newohem_ftground_s1_0319', 'freeze-resume from #33 epoch_24', '● Submitted', 'task: s1_ftground_newohem_from_nn_nohem_0310-train-normal'), C_S1ROOT),
    ('#35 s1_ds_is_from_ftground_newohem_0320',
     ('ds_is_ftground_newohem', 'freeze-resume from #34 epoch_48', '● Submitted', 'task: s1_ds_is_from_ftground_newohem_0320-train-pipeline'), C_S1ROOT),
]

C_WFTN = ('#fdf0e0', '#e08600')   # ftn old ohem weight variants
C_WNN  = ('#f0e8fd', '#8a2be2')  # nn_nohem weight variants

# Combined weight variants column — ftn on top, nn_nohem below (stacked at same x)
col_wvar_data = [
    ('#23 flat_favs42_muon_qkclip_ftn_0125_1105_0126_s4t100w_0310_woignore_160_73',
     ('ftn_0310wo · uniform weight', '**⚠ old ohem (XMSegHead)', 'task: flat_favs42_muon_qkclip_ftn_0125_1105_0126_s4t100w_0310_woignore_160_73-train'), C_WFTN),
    ('#24 flat_s4t100w_0310_woignore_160_73_5105_0316',
     ('ftn_0310wo · 5105 weight', '**⚠ old ohem (XMSegHead)', 'task: s4t100w_0310_woignore_160_73_5105-train-pipe'), C_WFTN),
    ('#22 flat_s4t100w_0310_woignore_nohem_5105_0317',
     ('nn_nohem_0310wo · 5105 weight', 'XMSegHeadBatchNorm', 'task: flat_s4t100w_0310_woignore_nohem_5105_0317-train-pipe'), C_WNN),
    ('#31 nn_nohem_0310ann_5105_0326',
     ('nn_nohem_0310ann_5105_v2', 'inherit label map: 73→2', 'rm 160 from class 9', '● Submitted', 'task: nn_nohem_0310ann_5105-train-normal-8w'), C_WNN),
]
# Track which nodes belong to which sub-group for dual subgraph boxes
WVAR_FTN_COUNT = 2   # first 2 nodes are ftn group
WVAR_NN_START = 2    # node index 2+ is nn group

C_FTG  = ('#e8f0fd', '#3478f6')  # ftground experiments
C_FTGNS = ('#fff0e8', '#ff6b35')  # ftground nsohem
C_FTGUB = ('#f0ffe8', '#7cb342')  # ftground ubgx10
C_FZDS = ('#f0e8ff', '#9b59b6')  # freezed ds_is experiments

# Downstream experiments share one column so directly related nodes stay visually close.
# Heuristic: place subgroup blocks in the same top-to-bottom order as their parent anchors.
# Here #24 -> ftground sits above #22 -> freezed ds_is, so ftground stays above.
col_downstream_data = [
    ('#26 flat_ftn_0125_ftground_from_5105_0316_0323',
     ('ftn ftground (old OHEM)', 'from 5105 epoch_24', 'task: flat_ftn_0125_ftground_from_5105_0316_0323'), C_FTG),
    ('#27 flat_ftn_0125_ftground_nsohem_from_5105_0323',
     ('nsohem ftground', 'XMSegHeadBatchNormSampleOHEM', 'from 5105 epoch_24', 'task: flat_ftn_0125_ftground_nsohem_from_5105_0323-train-free'), C_FTGNS),
    ('#28 flat_ftn_0125_ftground_ubgx10_from_5105_0323',
     ('ftn ftground ubgx10', 'XMSegHead with ubgx10', 'from 5105 epoch_24', 'task: flat_ftn_0125_ftground_ubgx10_from_5105_0323-train-free'), C_FTGUB),
    ('#30 flat_ftn_0125_ftground_newohem_cp1_from_nohem_5105_0324',
     ('newohem_cp1 ftground', 'freeze-resume from #22 epoch_24', '● Submitted', 'task: flat_ftn_0125_ftground_newohem_cp1_from_nohem_5105_0324-train-normal'), C_FTGNS),
    ('#37 ftground_newohem_cp1_from_nn_nohem_5105_0331',
     ('newohem_cp1 ftground', 'freeze-resume from #31 epoch_24', '✓ Completed', 'task: ftground_newohem_cp1_from_nn_nohem_5105_0331-train-pipe-4w'), C_FTGNS),
    ('#36 ftground_newohem_cp2_from_nn_nohem_5105_0330',
     ('newohem_cp2 ftground', 'freeze-resume from #31 epoch_24', '● Submitted', 'task: ftground_newohem_cp2_from_nn_nohem_5105-train-pipe-4w'), C_FTGNS),
    ('#29 ftn_0125_freezed_ds_is_cp1_share',
     ('ftn_0125 freezed ds_is cp1', 'freeze-resume from #22', '● Submitted', 'task: ftn_0125_freezed_ds_is_cp1-train-normal-8w'), C_FZDS),
]
DOWNSTREAM_FTG_COUNT = 6
DOWNSTREAM_FZDS_START = 6

col_followup_data = [
    ('#32 ftn_0125_freezed_ds_is_from_cp1_5105_0325',
     ('ftn_0125 freezed ds_is cp1', 'freeze-resume from #30 epoch_48', '● Submitted', 'task: ftn_0125_freezed_ds_is_cp1_from_newohem-train-normal-8w'), C_FZDS),
]


def _build_mermaid_node_line(indent, node_tuple):
    title, lines, _col = node_tuple
    node_num = title.split()[0].lstrip('#')
    body = "<br/>".join((title, *lines))
    return f'{indent}F{node_num}["{body}"]'


def build_experiment_tree_markdown():
    lines = [
        "# Experiment Evolution Tree",
        "",
        "```mermaid",
        "graph LR",
        '    ROOT(["s4t100w / epoch_24"])',
        '    S1ROOT(["s1 5frame retrain / epoch_48"])',
        "",
        '    subgraph "0125 ann"',
        "        direction TB",
        _build_mermaid_node_line("        ", col_0125_data[0]),
        _build_mermaid_node_line("        ", col_0125_data[1]),
        _build_mermaid_node_line("        ", col_0125_data[2]),
        _build_mermaid_node_line("        ", col_0125_data[3]),
        "        F7 -->|\"loss fix\"| F11",
        "        F7 -.->|\"ftn → nn_focal\"| F17",
        "    end",
        "",
        '    subgraph "0301 ann"',
        "        direction TB",
        _build_mermaid_node_line("        ", col_0301_data[0]),
        _build_mermaid_node_line("        ", col_0301_data[1]),
        _build_mermaid_node_line("        ", col_0301_data[2]),
        "    end",
        "",
        '    subgraph "0305 ann"',
        "        direction TB",
        _build_mermaid_node_line("        ", col_0305_data[0]),
        "    end",
        "",
        '    subgraph "0310 ann"',
        "        direction TB",
        _build_mermaid_node_line("        ", col_0310ig_data[0]),
        _build_mermaid_node_line("        ", col_0310wo_data[0]),
        _build_mermaid_node_line("        ", col_wvar_data[2]),
        _build_mermaid_node_line("        ", col_downstream_data[3]),
        _build_mermaid_node_line("        ", col_downstream_data[4]),
        _build_mermaid_node_line("        ", col_downstream_data[5]),
        _build_mermaid_node_line("        ", col_downstream_data[6]),
        _build_mermaid_node_line("        ", col_wvar_data[3]),
        "    end",
        "",
        '    subgraph "S1 0310 ann"',
        "        direction TB",
        _build_mermaid_node_line("        ", col_s1_data[0]),
        _build_mermaid_node_line("        ", col_s1_data[1]),
        _build_mermaid_node_line("        ", col_s1_data[2]),
        "    end",
        "",
        '    subgraph "Weight Variants"',
        "        direction TB",
        _build_mermaid_node_line("        ", col_wvar_data[1]),
        "    end",
        "",
        '    subgraph "Downstream 0323+"',
        "        direction TB",
        _build_mermaid_node_line("        ", col_downstream_data[0]),
        "    end",
        "",
        _build_mermaid_node_line("    ", col_followup_data[0]),
        "",
        "    ROOT --> F1",
        "    ROOT --> F7",
        "    F11 -->|\"0125 → 0301\"| F12",
        "    F12 -.->|\"ftn → nn_nohem\"| F18",
        "    F12 -->|\"map label\"| F16",
        "    F12 -->|\"0301 → 0305\"| F13",
        "    F13 -->|\"0305 → 0310 ignore\"| F14",
        "    F13 -->|\"0305 → 0310 w/o ignore\"| F15",
        "    F24 -->|\"ftground ftn\"| F26",
        "    F22 -->|\"inherit label map\"| F31",
        "    F22 -->|\"ftground newohem_cp1\"| F30",
        "    F31 -->|\"ftground newohem_cp1\"| F37",
        "    F31 -->|\"ftground newohem_cp2\"| F36",
        "    F22 -->|\"freezed ds_is cp1\"| F29",
        "    S1ROOT --> F33",
        "    F33 -.->|\"ftground newohem\"| F34",
        "    F34 -->|\"downstream + IS\"| F35",
        "    F30 -->|\"freezed ds_is cp1\"| F32",
        "```",
        "",
    ]
    return "\n".join(lines)

# ══════════════════════════════════════════════════════════════════════════════
# AUTO LAYOUT
# ══════════════════════════════════════════════════════════════════════════════
columns = [
    ('0125 ann',        col_0125_data,      '#f0f7ff', C_0125[1]),
    ('0301 ann',        col_0301_data,      '#f9f5ff', C_0301[1]),
    ('0305 ann',        col_0305_data,      '#f0faf4', C_0305[1]),
    ('0310 ignore',     col_0310ig_data,    '#fef8f0', C_0310[1]),
    ('0310 w/o ignore', col_0310wo_data,    '#fef8f0', C_0310[1]),
    ('weight variants', col_wvar_data,      '#fef0e0', C_WFTN[1]),
    ('downstream 0323+', col_downstream_data, '#f5f0ff', C_FZDS[1]),
    ('follow-up inherit', col_followup_data, '#f5f0ff', C_FZDS[1]),
]
MAINLINE_COL_IDX = next(i for i, (label, *_) in enumerate(columns) if label == '0125 ann')
WVAR_COL_IDX = next(i for i, (label, *_) in enumerate(columns) if label == 'weight variants')
DOWNSTREAM_COL_IDX = next(i for i, (label, *_) in enumerate(columns) if label == 'downstream 0323+')
FOLLOWUP_COL_IDX = next(i for i, (label, *_) in enumerate(columns) if label == 'follow-up inherit')
S1_SHARED_DEPTH_COLS = [MAINLINE_COL_IDX + depth for depth in range(len(col_s1_data))]

# Step 1: compute layout for each column (relative positions)
col_layouts = []
for ci, (_label, data, _fill, _border) in enumerate(columns):
    if ci == WVAR_COL_IDX:  # weight variants column: auto-gap before nn subgroup
        col_layouts.append(layout_column(data, subgroup_breaks={WVAR_NN_START}))
    elif ci == DOWNSTREAM_COL_IDX:
        col_layouts.append(layout_column(data, subgroup_breaks={DOWNSTREAM_FZDS_START}))
    else:
        col_layouts.append(layout_column(data))
s1_chain_layout = layout_column(col_s1_data)

# Step 2: find the global top and bottom across all columns
# All columns align their top node to the same y (TOP_Y)
TOP_Y = 8.0
col_abs = []  # list of list of (abs_cy, h)
global_bot = TOP_Y
for layouts in col_layouts:
    if not layouts:
        col_abs.append([])
        continue
    # Shift so first node center aligns with TOP_Y - LABEL_H - first_h/2
    first_cy, first_h = layouts[0]
    offset = TOP_Y - LABEL_H - first_h/2 - first_cy
    abs_layouts = [(cy + offset, h) for cy, h in layouts]
    col_abs.append(abs_layouts)
    bot = abs_layouts[-1][0] - abs_layouts[-1][1]/2 - PAD_Y
    global_bot = min(global_bot, bot)

# Step 2b: align inherited nodes to their parent's y-level
# Inherit edges: (parent_col, parent_node, child_col, child_node)
# The child's ENTIRE column shifts so child_node aligns horizontally with parent_node.
# Processed in order — if parent was already shifted by a prior rule, that's accounted for.
INHERIT_EDGES = [
    # Keep direct descendants visually close to their source nodes.
    (5, 2, 6, 3),  # #22 -> #30
    (6, 3, 7, 0),  # #30 -> #32
]

for parent_col, parent_node, child_col, child_node in INHERIT_EDGES:
    if child_col >= len(col_abs) or parent_col >= len(col_abs):
        continue
    parent_cy = col_abs[parent_col][parent_node][0]
    child_cy = col_abs[child_col][child_node][0]
    shift = parent_cy - child_cy
    if abs(shift) < 0.01:
        continue  # already aligned

    # Shift the entire child column
    col_abs[child_col] = [(cy + shift, h) for cy, h in col_abs[child_col]]

    # Check: does the shifted child column's top extend above its subgraph?
    # The subgraph top needs LABEL_H + PAD_Y above the first node.
    # If the first node moved up, the subgraph box grows upward — that's fine,
    # the figure auto-sizes via ylim.
    new_top = col_abs[child_col][0][0] + col_abs[child_col][0][1]/2 + PAD_Y + LABEL_H
    TOP_Y = max(TOP_Y, new_top)  # expand figure if needed

    # Update global_bot
    bot = col_abs[child_col][-1][0] - col_abs[child_col][-1][1]/2 - PAD_Y
    global_bot = min(global_bot, bot)

# Step 3: compute x positions — ROOT auto-positioned left of first column
ROOT_W = 1.55
SUBGRAPH_W = NODE_W + PAD_X * 2
ROOT_GAP = 0.8  # gap between ROOT right edge and first subgraph left edge
# First column left edge
first_col_x = ROOT_W + ROOT_GAP + SUBGRAPH_W / 2 + 0.3  # 0.3 left margin for root
ROOT_X = first_col_x - SUBGRAPH_W / 2 - ROOT_GAP - ROOT_W / 2

col_xs = []
x = first_col_x
for i, (_label, _data, _fill, _border) in enumerate(columns):
    col_xs.append(x)
    gap = COL_GAP_OVERRIDES.get((i, i + 1), COL_GAP)
    x += SUBGRAPH_W + gap

# Root anchors come from different branches: mainline root follows 0125, S1 root sits below it.
mainline_col = col_abs[MAINLINE_COL_IDX]
ROOT_NODE_H = 0.8
root_cy = (mainline_col[0][0] + mainline_col[1][0]) / 2 if len(mainline_col) >= 2 else mainline_col[0][0]
ROOT_STACK_GAP = 1.35
s1_root_cy = root_cy - ROOT_STACK_GAP

# S1 follows the same depth columns as the mainline: depth-1 shares 0125, depth-2 shares 0301, etc.
s1_lane_y = s1_root_cy + 0.15
s1_node_heights = [h for _cy, h in s1_chain_layout]
s1_node_cys = [s1_lane_y for _ in col_s1_data]
s1_chain_cys = [s1_root_cy, *s1_node_cys]

# Compare large frame against large frame: the whole S1 subgraph must sit below
# the overlapping shared-column subgraphs, not merely below an individual node.
S1_LEVEL_CLEARANCE = GAP_Y
S1_SUBGRAPH_CLEARANCE = GAP_Y + 0.05
s1_chain_shift = 0.0

root_bottom = root_cy - ROOT_NODE_H / 2
s1_root_top = s1_root_cy + ROOT_NODE_H / 2
s1_chain_shift = min(s1_chain_shift, (root_bottom - S1_LEVEL_CLEARANCE) - s1_root_top)

shared_subgraph_bottom = min(
    compute_subgraph_bounds(col_abs[col_idx])[1]
    for col_idx in S1_SHARED_DEPTH_COLS
)
s1_span_top = max(cy + h / 2 for cy, h in zip(s1_node_cys, s1_node_heights)) + PAD_Y + LABEL_H
s1_chain_shift = min(s1_chain_shift, (shared_subgraph_bottom - S1_SUBGRAPH_CLEARANCE) - s1_span_top)

if s1_chain_shift < -0.01:
    s1_root_cy += s1_chain_shift
    s1_node_cys = [cy + s1_chain_shift for cy in s1_node_cys]
    s1_chain_cys = [s1_root_cy, *s1_node_cys]

s1_node_centers = [
    (col_xs[col_idx], s1_node_cys[depth], s1_node_heights[depth])
    for depth, col_idx in enumerate(S1_SHARED_DEPTH_COLS)
]
s1_top = max(cy + h / 2 for _cx, cy, h in s1_node_centers) + PAD_Y + LABEL_H
TOP_Y = max(TOP_Y, s1_top)
global_bot = min(global_bot, min(cy - h / 2 for _cx, cy, h in s1_node_centers) - PAD_Y)
global_bot = min(global_bot, root_cy - ROOT_NODE_H / 2 - PAD_Y, s1_root_cy - ROOT_NODE_H / 2 - PAD_Y)

# Step 4: figure dimensions
FIG_W = x + 0.5
FIG_H = TOP_Y - global_bot + 2.5  # padding for legend at bottom

# ══════════════════════════════════════════════════════════════════════════════
# DRAW
# ══════════════════════════════════════════════════════════════════════════════
fig, ax = plt.subplots(figsize=(FIG_W, FIG_H))
ax.set_xlim(0, FIG_W)
ax.set_ylim(global_bot - 1.5, TOP_Y + 0.5)
ax.set_aspect('equal')
ax.axis('off')
fig.patch.set_facecolor(BG)
ax.set_facecolor(BG)

draw_node(ax, ROOT_X, root_cy, w=ROOT_W, h=ROOT_NODE_H,
          fill=C_ROOT[0], border=C_ROOT[1], lw=2,
          title='s4t100w', lines=('epoch_24',), node_id='root')
draw_node(ax, ROOT_X, s1_root_cy, w=ROOT_W, h=ROOT_NODE_H,
          fill=C_S1ROOT[0], border=C_S1ROOT[1], lw=2,
          title='s1 5frame retrain', lines=('epoch_48',), node_id='s1root')

# Draw columns: subgraph boxes + nodes
col_node_centers = []  # col_node_centers[col_idx][node_idx] = (cx, cy)
col_subgraph_boxes = [None] * len(columns)
for ci, (label, data, fill, border) in enumerate(columns):
    cx = col_xs[ci]
    layouts = col_abs[ci]
    if ci == WVAR_COL_IDX:
        # Draw two stacked subgraph boxes for weight variants
        ftn_layouts = layouts[:WVAR_FTN_COUNT]
        nn_layouts = layouts[WVAR_NN_START:]
        ftn_box = draw_subgraph(ax, cx, TOP_Y, data[:WVAR_FTN_COUNT], ftn_layouts,
                      'ftn + weight', '#fef0e0', C_WFTN[1])
        # nn subgraph box: top guaranteed below ftn box bottom
        ftn_box_bot = ftn_box[1] if ftn_box else nn_layouts[0][0]
        nn_top = ftn_box_bot - 0.15  # gap below ftn box
        draw_subgraph(ax, cx, nn_top, data[WVAR_NN_START:], nn_layouts,
                      'nn_nohem + weight', '#f5eaff', C_WNN[1])
        col_subgraph_boxes[ci] = compute_subgraph_bounds(layouts)
    elif ci == DOWNSTREAM_COL_IDX:
        ftg_layouts = layouts[:DOWNSTREAM_FTG_COUNT]
        fzds_layouts = layouts[DOWNSTREAM_FZDS_START:]
        ftg_box = draw_subgraph(ax, cx, TOP_Y, data[:DOWNSTREAM_FTG_COUNT], ftg_layouts,
                      'ftground 0323', '#f0f8ff', C_FTG[1])
        ftg_box_bot = ftg_box[1] if ftg_box else fzds_layouts[0][0]
        fzds_top = ftg_box_bot - 0.08
        draw_subgraph(ax, cx, fzds_top, data[DOWNSTREAM_FZDS_START:], fzds_layouts,
                      'freezed ds_is', '#f5f0ff', C_FZDS[1])
        col_subgraph_boxes[ci] = compute_subgraph_bounds(layouts)
    elif ci == FOLLOWUP_COL_IDX:
        pass  # standalone node, intentionally outside the freezed ds_is subgraph
    else:
        draw_subgraph(ax, cx, TOP_Y, data, layouts, label, fill, border)
        col_subgraph_boxes[ci] = compute_subgraph_bounds(layouts)
    # Draw nodes
    centers = []
    for ni, (title, lines, col) in enumerate(data):
        cy, h = layouts[ni]
        nid = title.split()[0].lstrip('#') if title.startswith('#') else None
        draw_node(ax, cx, cy, NODE_W, h, fill=col[0], border=col[1], lw=1.5,
                  title=title, lines=lines, node_id=nid)
        centers.append((cx, cy, h))
    col_node_centers.append(centers)

s1_span_box = draw_span_subgraph(ax, s1_node_centers, 'S1 0310 ann', '#f5f2ff', C_S1ROOT[1])
for (cx, cy, h), (title, lines, col) in zip(s1_node_centers, col_s1_data):
    nid = title.split()[0].lstrip('#') if title.startswith('#') else None
    draw_node(ax, cx, cy, NODE_W, h, fill=col[0], border=col[1], lw=1.5,
              title=title, lines=lines, node_id=nid)

# Helper to get node center
def nc(col_idx, node_idx):
    """Return (cx, cy, h) for a node."""
    return col_node_centers[col_idx][node_idx]

# ── Smart arrow helpers (all positions computed from node geometry) ───────────
def arrow_right(src, dst, label='', color=DARK, dashed=False,
                src_y_frac=0.0, dst_y_frac=0.0, rad=0.0,
                label_dx=0.0, label_dy=0.0, inherit=False):
    """Arrow from src right edge to dst left edge.
    inherit=True uses thick dotted arrow with filled head (--load-from relationship)."""
    sx, sy, sh = src
    dx, dy, dh = dst
    arrow(ax, sx + NODE_W/2, sy + src_y_frac * sh/2,
              dx - NODE_W/2, dy + dst_y_frac * dh/2,
          label=label, color=color, dashed=dashed, rad=rad,
          label_dx=label_dx, label_dy=label_dy,
          style_override=ARROW_INHERIT if inherit else None)

def arrow_right_root(dst, label='', color=DARK, y_offset=0.0):
    """Arrow from ROOT right edge to dst left edge."""
    dx, dy, dh = dst
    arrow(ax, ROOT_X + ROOT_W/2, root_cy + y_offset,
              dx - NODE_W/2, dy,
          label=label, color=color)

def arrow_down(src, dst, label='', color=DARK, dashed=False,
               x_frac=0.0, rad=0.0, label_dx=0.0, label_dy=0.0):
    """Arrow from src bottom edge to dst top edge."""
    sx, sy, sh = src
    dx, dy, dh = dst
    arrow(ax, sx + x_frac * NODE_W/2, sy - sh/2,
              dx + x_frac * NODE_W/2, dy + dh/2,
          label=label, color=color, dashed=dashed, rad=rad,
          label_dx=label_dx, label_dy=label_dy)

# ── Arrows (all auto-positioned) ────────────────────────────────────────────
n1  = nc(0, 0)
n7  = nc(0, 1)
n11 = nc(0, 2)
n17 = nc(0, 3)
n12 = nc(1, 0)
n18 = nc(1, 1)
n16 = nc(1, 2)
n13 = nc(2, 0)
n14 = nc(3, 0)
n15 = nc(4, 0)

# ROOT → #1 and #7 (fan out: offset y on ROOT side based on target positions)
root_spread = abs(n1[1] - n7[1]) / 4  # auto-spread based on target distance
arrow_right_root(n1, color=DARK, y_offset=root_spread)
arrow_right_root(n7, color=DARK, y_offset=-root_spread)

# 0125 internal: #7 → #11 (loss fix) — straight down, label left of center
arrow_down(n7, n11, label='loss fix', color=C_FIX[1], x_frac=-0.3)
# 0125 internal: #7 -.- #17 (ftn→nn_focal) — curved right to avoid #11
arrow_down(n7, n17, label='ftn→nn_focal', dashed=True, color=GRAY_TEXT,
           x_frac=0.9, rad=-0.4, label_dx=1.0)

# Cross-column: #11 → #12, #12 → #13
arrow_right(n11, n12, label='0125 → 0301', color=C_0301[1])
arrow_down(n12, n18, label='ftn→nn_nohem', dashed=True, color=GRAY_TEXT, x_frac=-0.3)
arrow_down(n12, n16, label='map label', color=C_0301[1], x_frac=0.3)
arrow_right(n12, n13, label='0301 → 0305', color=C_0305[1])

# #13 fans out to #14 and #15
# #13 → #14: direct horizontal (same row)
arrow_right(n13, n14, label='0305→0310 ignore', color=C_0310[1], src_y_frac=0.25, dst_y_frac=0.25)
# #13 → #15: curved below to avoid 0310 ignore column
# Place label in the gap between 0310_ignore and 0310_w/o_ignore columns (computed from col_xs)
gap_center_x = (col_xs[4] + col_xs[5]) / 2
arrow_mid_x = (n13[0] + n15[0]) / 2
label_shift = gap_center_x - arrow_mid_x  # auto-computed shift to gap between columns
arrow_right(n13, n15, label='0305→0310 w/o ign', color=C_0310[1],
            src_y_frac=-0.25, dst_y_frac=-0.25, rad=-0.2,
            label_dx=label_shift)

# #15 → #23 (ftn → ftn + weight)
n23 = nc(5, 0)
arrow_right(n15, n23, label='ftn + weight', color=C_WFTN[1])

# #20 → #22 (nn_nohem → nn_nohem + 5105 weight)
n20 = nc(4, 2)  # 0310wo column, 3rd node (nn_nohem)
n22 = nc(5, 2)  # wvar column, 3rd node (nn_nohem variant)
arrow_right(n20, n22, label='+ 5105 weight', color=C_WNN[1])
n31 = nc(5, 3)  # wvar column, 4th node (nn_nohem rerun)
arrow_down(n22, n31, label='inherit label map', color=C_WNN[1], x_frac=-0.2)

# S1 branch shares the same depth columns as the mainline while keeping its own lower y-band.
n33, n34, n35 = s1_node_centers
arrow(ax, ROOT_X + ROOT_W/2, s1_root_cy,
          n33[0] - NODE_W/2, n33[1],
      color=C_S1ROOT[1])
arrow_right(n33, n34, label='ftground newohem', color=C_FTGNS[1], src_y_frac=0.05, dst_y_frac=0.05, inherit=True)
arrow_right(n34, n35, label='downstream + IS', color=C_FZDS[1], src_y_frac=0.05, dst_y_frac=0.05, inherit=True)

# #24 → ftground experiments
n24 = nc(5, 1)  # wvar column, 2nd node (ftn 5105 weight)
n26 = nc(6, 0)  # downstream column, ftground node 0
n27 = nc(6, 1)  # downstream column, ftground node 1
n28 = nc(6, 2)  # downstream column, ftground node 2
arrow_right(n24, n26, label='ftground ftn', color=C_FTG[1], src_y_frac=0.38, dst_y_frac=0.22, rad=0.14, inherit=True)
arrow_right(n24, n27, label='ftground nsohem', color=C_FTGNS[1], src_y_frac=0.02, dst_y_frac=0.0, rad=0.02, inherit=True)
arrow_right(n24, n28, label='ftground ubgx10', color=C_FTGUB[1], src_y_frac=-0.38, dst_y_frac=-0.22, rad=-0.14, inherit=True)

# #22/#31 → downstream follow-ups and #30 → #32
n30 = nc(6, 3)  # downstream column, newohem_cp1 ftground from #22
n37 = nc(6, 4)  # downstream column, newohem_cp1 ftground from #31
n36 = nc(6, 5)  # downstream column, newohem_cp2 ftground
n29 = nc(6, 6)  # downstream column, direct freezed ds_is from #22
n32 = nc(7, 0)  # standalone follow-up node from #30
arrow_right(n22, n30, label='ftground newohem_cp1', color=C_FTGNS[1], src_y_frac=0.18, dst_y_frac=0.18, rad=0.06, inherit=True)
arrow_right(n31, n37, label='ftground newohem_cp1', color=C_FTGNS[1], src_y_frac=0.18, dst_y_frac=0.18, rad=0.04, inherit=True)
arrow_right(n31, n36, label='ftground newohem_cp2', color=C_FTGNS[1], src_y_frac=-0.12, dst_y_frac=-0.05, rad=-0.03, inherit=True)
arrow_right(n22, n29, label='freezed ds_is cp1', color=C_FZDS[1], src_y_frac=-0.24, dst_y_frac=0.0, rad=-0.08, inherit=True)
arrow_right(n30, n32, label='freezed ds_is cp1', color=C_FZDS[1], inherit=True)

# ── Legend ────────────────────────────────────────────────────────────────────
legend_items = [
    ('0125 ann', C_0125), ('0301 ann', C_0301),
    ('0305 ann', C_0305), ('0310 ann', C_0310),
    ('s1 root',  C_S1ROOT),
    ('ftn+wt',   C_WFTN), ('nn+wt',    C_WNN),
    ('ftground', C_FTG),  ('fz ds_is', C_FZDS), ('error',    C_ERR),  ('fixed',    C_FIX),
]
legend_y = global_bot - 0.8
lx = 0.5
for i, (lbl, col) in enumerate(legend_items):
    bx = lx + i * 2.8
    patch = FancyBboxPatch((bx, legend_y - 0.18), 0.38, 0.36,
                           boxstyle='round,pad=0.04',
                           facecolor=col[0], edgecolor=col[1], lw=1.2, zorder=3)
    ax.add_patch(patch)
    ax.text(bx + 0.52, legend_y, lbl, va='center', fontsize=7,
            fontfamily=FONT, color=DARK, zorder=4)

# Arrow type legend
arrow_legend_y = legend_y - 0.7
ax.annotate('', xy=(1.8, arrow_legend_y), xytext=(0.5, arrow_legend_y),
            arrowprops={**ARROW_NORMAL, 'color': DARK}, zorder=3)
ax.text(2.0, arrow_legend_y, 'config change', va='center', fontsize=7,
        fontfamily=FONT, color=DARK, zorder=4)
ax.annotate('', xy=(6.3, arrow_legend_y), xytext=(5.0, arrow_legend_y),
            arrowprops={**ARROW_INHERIT, 'color': DARK}, zorder=3)
ax.text(6.5, arrow_legend_y, 'load-from (inherit)', va='center', fontsize=7,
        fontfamily=FONT, color=DARK, zorder=4)

plt.tight_layout(pad=0.3)
out_dir = os.path.dirname(os.path.abspath(__file__))
md_path = Path(out_dir) / 'experiment_tree.md'
md_path.write_text(build_experiment_tree_markdown())
fig.savefig(os.path.join(out_dir, 'experiment_tree.png'), dpi=180, bbox_inches='tight', facecolor=BG)
fig.savefig(os.path.join(out_dir, 'experiment_tree.svg'), bbox_inches='tight', facecolor=BG)
print('Saved experiment_tree.md + experiment_tree.png + experiment_tree.svg')
