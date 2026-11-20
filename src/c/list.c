// One Kind's list: the band (the Kind, and what's in it: '12 unread'), then a MenuLayer with a row
// per item in the phone's order. Each row has the item's state mark on the left (✓ ✗ ● ○, dashed ○
// for a draft), its title in Gothic 18 Bold and its Sub below in Gothic 14; an unread
// notification has a dot on the right. On round the mark, title and dot are centred as a group.
//
// Notifications come in sections by Group (Review requested, Mentioned, Assigned, Builds, Other),
// each under a header drawn by hand (centred on round), and end with 'Mark all read', which asks
// to be held. The repositories for a new issue are the same window without marks: Select starts
// dictating the issue for the one picked.
//
// Before a Kind's list has come the body is one row saying so; an empty list says "Nothing here".
#include "inbox.h"

#define ROW_H PBL_IF_ROUND_ELSE(42, 36)
#define SECTION_H PBL_IF_ROUND_ELSE(22, 18)
#define MARK_R 6
#define MARK_X 11
#define TEXT_X 22
#define DOT_R 3
#define ROUND_INSET 12
// Round: the mark, title and dot keep this far in, so a row near the bottom of the screen still shows them.
#define ROUND_GROUP_INSET (PBL_DISPLAY_WIDTH / 12)
#define ROUND_GAP 6
#define MAX_ITEMS 15
#define NO_SECTION 0xFF
#define WAITING "Waiting for your phone\xe2\x80\xa6"
#define NO_PHONE "Connect your phone to see your GitHub inbox."
#define NOTHING "Nothing here"

static Window *s_window;
static Layer *s_header;
static MenuLayer *s_menu;
static uint8_t s_kind;
static GFont s_title_font;
static GFont s_sub_font;
static GFont s_section_font;
static GFont s_message_font;
static uint32_t s_selected;  // the selected item's id, hashed, to keep it when rows move

// The rows: items in section order (s_order), each section a run of it.
static uint8_t s_order[MAX_ITEMS];
static uint8_t s_section_group[GROUP_COUNT];  // NO_SECTION: no header
static uint8_t s_section_start[GROUP_COUNT];
static uint8_t s_section_len[GROUP_COUNT];
static uint8_t s_sections;    // item sections
static bool s_mark_all;       // and after them, the 'Mark all read' section

static List *prv_list(void) {
  return app_list(s_kind);
}

static bool prv_has_items(void) {
  const List *list = prv_list();
  return list && list->have && list->count > 0;
}

/** Sections for the list as it is now: by Group for notifications (in Group order, the phone's
 * order within each), else one section of everything. */
static void prv_layout(void) {
  const List *list = prv_list();
  s_sections = 0;
  s_mark_all = false;
  if (!prv_has_items()) {
    return;
  }
  const int count = list->count < MAX_ITEMS ? list->count : MAX_ITEMS;
  if (s_kind != KIND_NOTIFICATION) {
    for (int i = 0; i < count; i++) {
      s_order[i] = i;
    }
    s_section_group[0] = NO_SECTION;
    s_section_start[0] = 0;
    s_section_len[0] = count;
    s_sections = 1;
    return;
  }
  int at = 0;
  for (int g = 0; g < GROUP_COUNT; g++) {
    const int start = at;
    for (int i = 0; i < count; i++) {
      if (list->items[i].group == g) {
        s_order[at++] = i;
      }
    }
    if (at > start) {
      s_section_group[s_sections] = g;
      s_section_start[s_sections] = start;
      s_section_len[s_sections] = at - start;
      s_sections++;
    }
  }
  s_mark_all = g_app.summary.unread > 0 || list_unread(KIND_NOTIFICATION) > 0;
}

/** The item at a row, or NULL for the message and 'Mark all read' rows. */
static Item *prv_item_at(const MenuIndex *index) {
  if (index->section >= s_sections || index->row >= s_section_len[index->section]) {
    return NULL;
  }
  return &prv_list()->items[s_order[s_section_start[index->section] + index->row]];
}

static bool prv_index_of(uint32_t hash, MenuIndex *out) {
  for (int s = 0; s < s_sections; s++) {
    for (int r = 0; r < s_section_len[s]; r++) {
      const MenuIndex index = MenuIndex(s, r);
      const Item *item = prv_item_at(&index);
      if (item && ib_hash(item->id) == hash) {
        *out = index;
        return true;
      }
    }
  }
  return false;
}

static int16_t prv_text_h(const char *text, GFont font, int16_t w) {
  return graphics_text_layout_get_content_size(text, font, GRect(0, 0, w, 1000),
                                               GTextOverflowModeWordWrap,
                                               GTextAlignmentCenter).h;
}

// ---------------------------------------------------------------- header

static void prv_header_update(Layer *layer, GContext *ctx) {
  char title[40];
  format_count(title, sizeof(title), s_kind, false);
  if (!header_title_fits(layer_get_bounds(layer), title)) {
    format_count(title, sizeof(title), s_kind, true);
  }
  header_draw(ctx, layer_get_bounds(layer), BAND_COLOUR, ACCENT, GColorWhite, MARK_ICON,
              kind_label(s_kind), title);
}

// ---------------------------------------------------------------- menu

static uint16_t prv_num_sections(MenuLayer *menu, void *context) {
  return s_sections ? s_sections + (s_mark_all ? 1 : 0) : 1;
}

static uint16_t prv_num_rows(MenuLayer *menu, uint16_t section, void *context) {
  return section < s_sections ? s_section_len[section] : 1;
}

static int16_t prv_header_h(MenuLayer *menu, uint16_t section, void *context) {
  return section < s_sections && s_section_group[section] != NO_SECTION ? SECTION_H : 0;
}

static int16_t prv_separator_h(MenuLayer *menu, MenuIndex *index, void *context) {
  return 0;
}

static int16_t prv_row_h(MenuLayer *menu, MenuIndex *index, void *context) {
  if (!s_sections) {
    return layer_get_bounds(menu_layer_get_layer(menu)).size.h;
  }
  return ROW_H;
}

static void prv_draw_header(GContext *ctx, const Layer *cell, uint16_t section, void *context) {
  const GRect bounds = layer_get_bounds(cell);
  if (section >= s_sections || s_section_group[section] == NO_SECTION) {
    return;
  }
  graphics_context_set_fill_color(ctx, BAND_COLOUR);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);
  graphics_context_set_text_color(ctx, PBL_IF_COLOR_ELSE(GColorWhite, GColorWhite));
  graphics_draw_text(ctx, group_label(s_section_group[section]), s_section_font,
                     GRect(MARGIN, PBL_IF_ROUND_ELSE(1, -1), bounds.size.w - 2 * MARGIN, 18),
                     GTextOverflowModeTrailingEllipsis,
                     PBL_IF_ROUND_ELSE(GTextAlignmentCenter, GTextAlignmentLeft), NULL);
#if !defined(PBL_COLOR)
  // The black header would run into the black rows: rule it off.
  graphics_context_set_stroke_color(ctx, GColorWhite);
  graphics_draw_line(ctx, GPoint(0, bounds.size.h - 1), GPoint(bounds.size.w, bounds.size.h - 1));
#endif
}

static void prv_draw_message(GContext *ctx, GRect bounds, const char *text) {
  const int16_t w = bounds.size.w - 2 * MARGIN;
  const int16_t h = prv_text_h(text, s_message_font, w);
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);
  graphics_context_set_text_color(ctx, GColorWhite);
  graphics_draw_text(ctx, text, s_message_font,
                     GRect(MARGIN, (bounds.size.h - h) / 2 - 8, w, h + 8),
                     GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
}

/** One row: a mark (or none, < 0), a title, the words below, and an unread dot. */
static void prv_draw_entry(GContext *ctx, const Layer *cell, int mark, GColor mark_colour,
                           const char *title, const char *sub, bool dot, bool highlighted) {
  const GRect bounds = layer_get_bounds(cell);
  const GColor ink = highlighted ? GColorBlack : GColorWhite;
  const GColor dim = highlighted ? DIM_ON_WHITE : DIM_COLOUR;
  const GColor dot_colour = highlighted ? ACCENT_ON_WHITE : ACCENT;
  const bool has_sub = sub && sub[0];
  // Without words below, the title sits in the middle of the row.
  const int16_t title_y = has_sub ? PBL_IF_ROUND_ELSE(-1, -3) : (bounds.size.h - 22) / 2 - 3;
#if defined(PBL_ROUND)
  const int16_t mark_w = mark >= 0 ? 2 * MARK_R + ROUND_GAP : 0;
  const int16_t dot_w = dot ? 2 * DOT_R + ROUND_GAP : 0;
  int16_t title_w = graphics_text_layout_get_content_size(
      title, s_title_font, GRect(0, 0, 400, 30), GTextOverflowModeTrailingEllipsis,
      GTextAlignmentLeft).w;
  const int16_t room = bounds.size.w - 2 * ROUND_GROUP_INSET - mark_w - dot_w;
  if (title_w > room) {
    title_w = room;
  }
  const int16_t x = (bounds.size.w - (mark_w + title_w + dot_w)) / 2;
  const int16_t mid = title_y + 13;
  if (mark >= 0) {
    draw_mark(ctx, GPoint(x + MARK_R, mid), MARK_R, mark, mark_colour);
  }
  graphics_context_set_text_color(ctx, ink);
  graphics_draw_text(ctx, title, s_title_font, GRect(x + mark_w, title_y, title_w + 2, 22),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  if (dot) {
    graphics_context_set_fill_color(ctx, dot_colour);
    graphics_fill_circle(ctx, GPoint(x + mark_w + title_w + ROUND_GAP + DOT_R, mid), DOT_R);
  }
  if (has_sub) {
    graphics_context_set_text_color(ctx, dim);
    graphics_draw_text(ctx, sub, s_sub_font,
                       GRect(ROUND_INSET, 19, bounds.size.w - 2 * ROUND_INSET, 18),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  }
#else
  const int16_t x = mark >= 0 ? TEXT_X : MARGIN;
  const int16_t w = bounds.size.w - x - 4 - (dot ? 2 * DOT_R + 4 : 0);
  if (mark >= 0) {
    draw_mark(ctx, GPoint(MARK_X, title_y + 13), MARK_R, mark, mark_colour);
  }
  graphics_context_set_text_color(ctx, ink);
  graphics_draw_text(ctx, title, s_title_font, GRect(x, title_y, w, 22),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  if (dot) {
    graphics_context_set_fill_color(ctx, dot_colour);
    graphics_fill_circle(ctx, GPoint(bounds.size.w - 4 - DOT_R, title_y + 13), DOT_R);
  }
  if (has_sub) {
    graphics_context_set_text_color(ctx, dim);
    graphics_draw_text(ctx, sub, s_sub_font, GRect(x, 16, bounds.size.w - x - 4, 18),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  }
#endif
}

static void prv_draw_row(GContext *ctx, const Layer *cell, MenuIndex *index, void *context) {
  if (!s_sections) {
    const List *list = prv_list();
    prv_draw_message(ctx, layer_get_bounds(cell),
                     list && list->have ? NOTHING : g_app.connected ? WAITING : NO_PHONE);
    return;
  }
  const bool highlighted = menu_cell_layer_is_highlighted(cell);
  const Item *item = prv_item_at(index);
  if (!item) {
    char sub[24] = "";
    const int unread = g_app.summary.unread ? g_app.summary.unread
                                            : list_unread(KIND_NOTIFICATION);
    snprintf(sub, sizeof(sub), "%d unread", unread);
    prv_draw_entry(ctx, cell, STATE_GOOD, highlighted ? ACCENT_ON_WHITE : ACCENT,
                   "Mark all read", sub, false, highlighted);
    return;
  }
  const bool is_repo = s_kind == KIND_REPO;
  const char *sub = is_repo ? (item->flags & FLAG_DEFAULT ? "New issues go here" : "") : item->sub;
  prv_draw_entry(ctx, cell, is_repo ? -1 : item->state, state_colour(item->state, highlighted),
                 item->title, sub, item->flags & FLAG_UNREAD, highlighted);
}

static void prv_select(MenuLayer *menu, MenuIndex *index, void *context) {
  if (!s_sections) {
    return;
  }
  const Item *item = prv_item_at(index);
  if (!item) {
    act_confirm_mark_all();
  } else if (s_kind == KIND_REPO) {
    // The instance id is the owner/repo the plugin checks against; the title may be cut short.
    act_new_issue(item->id[0] ? item->id : item->title);
  } else {
    detail_window_push(s_kind, item);
  }
}

static void prv_selection_changed(MenuLayer *menu, MenuIndex new_index, MenuIndex old_index,
                                  void *context) {
  const Item *item = s_sections ? prv_item_at(&new_index) : NULL;
  s_selected = item ? ib_hash(item->id) : 0;  // 0: 'Mark all read', kept by place
}

/** Selects the item last selected, if it's still there; else the default repository, or the top. */
static void prv_reselect(bool force) {
  MenuIndex index;
  if (!s_sections) {
    return;
  }
  if (!prv_index_of(s_selected, &index)) {
    const List *list = prv_list();
    index = MenuIndex(0, 0);
    if (s_kind == KIND_REPO) {
      for (int i = 0; i < list->count; i++) {
        if (list->items[i].flags & FLAG_DEFAULT) {
          index = MenuIndex(0, i);
        }
      }
    }
    if (!force) {
      // Gone: stay put if the row is still there, else go to the top.
      const MenuIndex at = menu_layer_get_selected_index(s_menu);
      if (at.section < prv_num_sections(s_menu, NULL) &&
          at.row < prv_num_rows(s_menu, at.section, NULL)) {
        index = at;
      }
    }
  }
  const MenuIndex at = menu_layer_get_selected_index(s_menu);
  if (force || at.section != index.section || at.row != index.row) {
    menu_layer_set_selected_index(s_menu, index, MenuRowAlignCenter, false);
  }
  const Item *item = prv_item_at(&index);
  if (item) {
    s_selected = ib_hash(item->id);
  }
}

// ---------------------------------------------------------------- window

static void prv_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  const GRect bounds = layer_get_bounds(root);
  window_set_background_color(window, GColorBlack);

  s_title_font = fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);
  s_sub_font = fonts_get_system_font(FONT_KEY_GOTHIC_14);
  s_section_font = fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD);
  s_message_font = fonts_get_system_font(FONT_KEY_GOTHIC_18);
  prv_layout();

  s_menu = menu_layer_create(GRect(0, HEADER_H, bounds.size.w, bounds.size.h - HEADER_H));
  menu_layer_set_center_focused(s_menu, false);
  menu_layer_set_normal_colors(s_menu, GColorBlack, GColorWhite);
  menu_layer_set_highlight_colors(s_menu, GColorWhite, GColorBlack);
  menu_layer_set_callbacks(s_menu, NULL, (MenuLayerCallbacks) {
    .get_num_sections = prv_num_sections,
    .get_num_rows = prv_num_rows,
    .get_header_height = prv_header_h,
    .draw_header = prv_draw_header,
    .get_cell_height = prv_row_h,
    .get_separator_height = prv_separator_h,
    .draw_row = prv_draw_row,
    .select_click = prv_select,
    .selection_changed = prv_selection_changed,
  });
  menu_layer_set_click_config_onto_window(s_menu, window);
  layer_add_child(root, menu_layer_get_layer(s_menu));
  s_selected = 0;
  prv_reselect(true);

  s_header = layer_create(GRect(0, 0, bounds.size.w, HEADER_H));
  layer_set_update_proc(s_header, prv_header_update);
  layer_add_child(root, s_header);
}

static void prv_unload(Window *window) {
  menu_layer_destroy(s_menu);
  s_menu = NULL;
  layer_destroy(s_header);
  s_header = NULL;
}

void list_window_push(uint8_t kind) {
  if (s_menu) {
    return;  // already open
  }
  s_kind = kind;
  if (!s_window) {
    s_window = window_create();
    window_set_window_handlers(s_window, (WindowHandlers) {
      .load = prv_load,
      .unload = prv_unload,
    });
  }
  window_stack_push(s_window, true);
}

void list_window_destroy(void) {
  if (s_window) {
    window_destroy(s_window);
    s_window = NULL;
  }
}

/** The repository picker has done its job once the issue is on its way: Back goes Home. */
void list_close_picker(void) {
  if (s_menu && s_kind == KIND_REPO) {
    window_stack_remove(s_window, false);
  }
}

/** A Kind's list (0: any) or the counts have changed: redraw, keeping the same item selected
 * when items move or a section comes or goes above it. */
void list_refresh(uint8_t kind) {
  if (!s_menu || (kind && kind != s_kind)) {
    return;
  }
  const bool had = s_sections > 0;
  prv_layout();
  menu_layer_reload_data(s_menu);
  prv_reselect(!had);
  if (s_header) {
    layer_mark_dirty(s_header);
  }
}
