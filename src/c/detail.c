// One item: the band in its state's colour (green, amber, red, or grey for none and drafts) with
// its state mark, what it is ('PULL REQUEST', or a notification's group) and the end of its Sub
// ('Failing', or a notification's age); then, in a ScrollLayer, its title in full in Gothic 24
// Bold, where it is (the rest of the Sub: 'acme/api #145') in grey, the phone's lines about it in
// Gothic 18, and 'Select for actions' when there are any. The Sub is split so the band's title
// fits on one line under its label. On round the text follows the screen's edge and scrolls a page
// at a time.
//
// Select opens an ActionMenu with what the item's Flags allow: Mark read, Done, Reply by voice,
// Rerun failed jobs. The choice is acted on once the menu has closed (act.c).
//
// The window keeps its own copies of the texts, so a new list arriving while it's open can't pull
// them from under it; only the flags follow the list, so a notification read elsewhere (or just
// now) no longer offers Mark read.
#include "inbox.h"

#define DETAIL_MARGIN PBL_IF_ROUND_ELSE(10, 6)
#define FLOW_INSET 8
#define MAX_ACTIONS 4
#define HINT "Select for actions"

static Window *s_window;
static Layer *s_header;
static ScrollLayer *s_scroll;
static TextLayer *s_title_layer;
static TextLayer *s_where_layer;
static TextLayer *s_text_layer;
static TextLayer *s_hint_layer;
static uint8_t s_kind;
static uint8_t s_state;
static uint8_t s_flags;
static uint8_t s_group;
static char *s_id;
static char *s_title;
static char *s_sub;
static char *s_where;         // the Sub before its last ' · ', or NULL when it has none
static const char *s_status;  // the Sub after it (or all of it), in s_sub
static char *s_text;
static ActionMenuLevel *s_actions;
static uint8_t s_chosen;  // the action picked, acted on when the menu has closed

static void prv_free_texts(void) {
  free(s_id);
  free(s_title);
  free(s_sub);
  free(s_where);
  free(s_text);
  s_id = s_title = s_sub = s_where = s_text = NULL;
  s_status = NULL;
}

/** 'acme/api #145 · Failing' -> where 'acme/api #145', status 'Failing'. */
static void prv_split_sub(void) {
  static const char SEP[] = " \xc2\xb7 ";
  s_where = NULL;
  s_status = s_sub;
  const char *last = NULL;
  for (const char *p = s_sub ? strstr(s_sub, SEP) : NULL; p; p = strstr(p + 1, SEP)) {
    last = p;
  }
  if (last) {
    s_where = ib_strndup(s_sub, last - s_sub);
    s_status = last + sizeof(SEP) - 1;
  }
}

static const char *prv_label(void) {
  switch (s_kind) {
    case KIND_NOTIFICATION:
      switch (s_group) {
        case GROUP_REVIEW: return "REVIEW REQUESTED";
        case GROUP_MENTIONED: return "MENTIONED";
        case GROUP_ASSIGNED: return "ASSIGNED";
        case GROUP_BUILDS: return "BUILD";
        default: return "NOTIFICATION";
      }
    case KIND_REVIEW: return "REVIEW REQUEST";
    case KIND_PR: return "PULL REQUEST";
    case KIND_BUILD: return "BUILD";
    default: return "";
  }
}

static bool prv_has_actions(void) {
  const uint8_t can = FLAG_CAN_MARK | FLAG_CAN_RERUN | PBL_IF_MICROPHONE_ELSE(FLAG_CAN_COMMENT, 0);
  return (s_flags & can) != 0;
}

static void prv_header_update(Layer *layer, GContext *ctx) {
  const GColor band = state_band(s_state);
  const GColor ink = ink_on(band);
  // On grey (no state, or a draft), the label is the app's blue, as on the other bands.
  const GColor label = gcolor_equal(band, BAND_COLOUR) ? ACCENT : ink;
  header_draw(ctx, layer_get_bounds(layer), band, label, ink, s_state, prv_label(), s_status);
}

// ---------------------------------------------------------------- actions

static void prv_performed(ActionMenu *menu, const ActionMenuItem *action, void *context) {
  s_chosen = (uint8_t)(uintptr_t)action_menu_item_get_action_data(action);
}

static void prv_menu_closed(ActionMenu *menu, const ActionMenuItem *performed, void *context) {
  action_menu_hierarchy_destroy(s_actions, NULL, NULL);
  s_actions = NULL;
  const uint8_t chosen = s_chosen;
  s_chosen = 0;
  if (!s_id) {
    return;  // the window has gone
  }
  switch (chosen) {
    case ACT_MARK_READ:
    case ACT_MARK_DONE:
      act_simple(chosen, s_id);
      break;
    case ACT_COMMENT:
      act_reply(s_id);
      break;
    case ACT_RERUN:
      act_confirm_rerun(s_id);
      break;
    default:
      break;
  }
}

static void prv_add(const char *label, uint8_t act) {
  action_menu_level_add_action(s_actions, label, prv_performed, (void *)(uintptr_t)act);
}

static void prv_select(ClickRecognizerRef recognizer, void *context) {
  if (s_actions || !prv_has_actions()) {
    return;
  }
  s_actions = action_menu_level_create(MAX_ACTIONS);
  if (!s_actions) {
    return;
  }
  if ((s_flags & FLAG_CAN_MARK) && (s_flags & FLAG_UNREAD)) {
    prv_add("Mark read", ACT_MARK_READ);
  }
  if (s_flags & FLAG_CAN_MARK) {
    prv_add("Done", ACT_MARK_DONE);
  }
#if defined(PBL_MICROPHONE)
  if (s_flags & FLAG_CAN_COMMENT) {
    prv_add("Reply by voice", ACT_COMMENT);
  }
#endif
  if (s_flags & FLAG_CAN_RERUN) {
    prv_add("Rerun failed jobs", ACT_RERUN);
  }
#if defined(PBL_COLOR)
  // The menu's left column in the band's colour (blue for a grey band).
  GColor column = state_band(s_state);
  if (gcolor_equal(column, BAND_COLOUR)) {
    column = ACCENT;
  }
#else
  const GColor column = GColorWhite;
#endif
  ActionMenuConfig config = {
    .root_level = s_actions,
    .colors = {
      .background = column,
      .foreground = ink_on(column),
    },
    .did_close = prv_menu_closed,
    .align = ActionMenuAlignCenter,
  };
  action_menu_open(&config);
}

static void prv_click_config(void *context) {
  window_single_click_subscribe(BUTTON_ID_SELECT, prv_select);
}

// ---------------------------------------------------------------- window

/** A block of text at *y in the scrolling content, sized to fit; moves *y past it. */
static TextLayer *prv_block(const char *text, const char *font, GColor color, int16_t width,
                            int16_t *y) {
  if (!text || !*text) {
    return NULL;
  }
  const int16_t w = width - 2 * DETAIL_MARGIN;
  TextLayer *layer = text_layer_create(GRect(DETAIL_MARGIN, *y, w, 2000));
  if (!layer) {
    return NULL;
  }
  text_layer_set_text(layer, text);
  text_layer_set_font(layer, fonts_get_system_font(font));
  text_layer_set_text_color(layer, color);
  text_layer_set_background_color(layer, GColorClear);
  text_layer_set_text_alignment(layer, PBL_IF_ROUND_ELSE(GTextAlignmentCenter, GTextAlignmentLeft));
  text_layer_set_overflow_mode(layer, GTextOverflowModeWordWrap);
  scroll_layer_add_child(s_scroll, text_layer_get_layer(layer));
#if defined(PBL_ROUND)
  text_layer_enable_screen_text_flow_and_paging(layer, FLOW_INSET);
#endif
  const GSize size = text_layer_get_content_size(layer);
  layer_set_frame(text_layer_get_layer(layer), GRect(DETAIL_MARGIN, *y, w, size.h + 4));
  *y += size.h + 4;
  return layer;
}

static void prv_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  const GRect bounds = layer_get_bounds(root);
  window_set_background_color(window, GColorBlack);

  s_scroll = scroll_layer_create(GRect(0, HEADER_H, bounds.size.w, bounds.size.h - HEADER_H));
  scroll_layer_set_click_config_onto_window(s_scroll, window);
  scroll_layer_set_callbacks(s_scroll, (ScrollLayerCallbacks) {
    .click_config_provider = prv_click_config,
  });
  scroll_layer_set_shadow_hidden(s_scroll, true);
  layer_add_child(root, scroll_layer_get_layer(s_scroll));

  s_header = layer_create(GRect(0, 0, bounds.size.w, HEADER_H));
  layer_set_update_proc(s_header, prv_header_update);
  layer_add_child(root, s_header);

  int16_t y = 2;
  s_title_layer = prv_block(s_title, FONT_KEY_GOTHIC_24_BOLD, GColorWhite, bounds.size.w, &y);
  s_where_layer = prv_block(s_where, FONT_KEY_GOTHIC_18, DIM_COLOUR, bounds.size.w, &y);
  y += 2;
  s_text_layer = prv_block(s_text, FONT_KEY_GOTHIC_18, GColorWhite, bounds.size.w, &y);
  y += 4;
  s_hint_layer = prv_has_actions() ? prv_block(HINT, FONT_KEY_GOTHIC_14, DIM_COLOUR,
                                               bounds.size.w, &y)
                                   : NULL;
  y += PBL_IF_ROUND_ELSE(24, 8);
  scroll_layer_set_content_size(s_scroll, GSize(bounds.size.w, y));
#if defined(PBL_ROUND)
  scroll_layer_set_paging(s_scroll, true);
#endif
}

static void prv_unload(Window *window) {
  text_layer_destroy(s_title_layer);
  text_layer_destroy(s_where_layer);
  text_layer_destroy(s_text_layer);
  text_layer_destroy(s_hint_layer);
  s_title_layer = s_where_layer = s_text_layer = s_hint_layer = NULL;
  scroll_layer_destroy(s_scroll);
  s_scroll = NULL;
  layer_destroy(s_header);
  s_header = NULL;
  prv_free_texts();
}

void detail_window_push(uint8_t kind, const Item *item) {
  if (s_scroll) {
    return;  // already open
  }
  prv_free_texts();
  s_id = ib_strndup(item->id, ID_MAX);
  s_title = ib_strndup(item->title, TITLE_MAX);
  s_sub = ib_strndup(item->sub, SUB_MAX);
  prv_split_sub();
  s_text = ib_strndup(item->text, TEXT_MAX);
  s_kind = kind;
  s_state = item->state;
  s_flags = item->flags;
  s_group = item->group;
  if (!s_window) {
    s_window = window_create();
    window_set_window_handlers(s_window, (WindowHandlers) {
      .load = prv_load,
      .unload = prv_unload,
    });
  }
  window_stack_push(s_window, true);
}

void detail_window_destroy(void) {
  if (s_window) {
    window_destroy(s_window);
    s_window = NULL;
  }
}

/** Done: the item has gone, so its window goes too (from under the result showing). */
void detail_window_close(void) {
  if (s_scroll) {
    window_stack_remove(s_window, false);
  }
}

void detail_refresh(void) {
  if (!s_scroll) {
    return;
  }
  const Item *item = list_find(s_kind, s_id);
  if (item) {
    s_flags = item->flags;
  }
}
