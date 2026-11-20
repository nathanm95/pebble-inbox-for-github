// Home: the band (INBOX and '@login'; 'UPDATED 15:02' once the counts are getting old, 'NO PHONE'
// while the phone is away), then a MenuLayer: Notifications, Reviews, My pull requests, Builds
// (only with repositories chosen for builds), New issue (only with a repository for issues) and
// Refresh, each with a few words and a count badge on the right, red when something is failing
// (filled rather than outlined on black-and-white watches). The phone's notice, when there is one,
// is an amber row above them.
//
// Before the phone has sent anything (and with nothing saved) the body is one row saying so; when
// it says nobody is signed in and there's nothing to show, the row says where to sign in.
#include "inbox.h"

#define ROW_H PBL_IF_ROUND_ELSE(42, 36)
#define BADGE_H 22
#define BADGE_PAD 5
#define BADGE_MIN_W 24
#define ROUND_INSET 12
// Round: the name and badge keep this far in, so a row near the bottom of the screen still shows them.
#define ROUND_GROUP_INSET (PBL_DISPLAY_WIDTH / 12)
#define WAITING "Waiting for your phone\xe2\x80\xa6"
#define NO_PHONE "Connect your phone to see your GitHub inbox."
#define SIGN_IN "Sign in to GitHub in the Pebble app: Inbox for GitHub \xe2\x80\xba Settings."

typedef enum {
  ROW_NOTICE,
  ROW_NOTIFICATIONS,
  ROW_REVIEWS,
  ROW_PRS,
  ROW_BUILDS,
  ROW_NEW_ISSUE,
  ROW_REFRESH,
} HomeRow;
#define MAX_ROWS 7

static Window *s_window;
static Layer *s_header;
static MenuLayer *s_menu;
static GFont s_title_font;
static GFont s_sub_font;
static GFont s_badge_font;
static GFont s_notice_font;
static GFont s_message_font;
static HomeRow s_rows[MAX_ROWS];
static int s_row_count;           // 0: the body is a message
static HomeRow s_selected = ROW_NOTIFICATIONS;

/** The rows Home shows now. */
static void prv_layout(void) {
  s_row_count = 0;
  if (!g_app.have_summary || app_signed_out()) {
    return;
  }
  if (g_app.notice[0]) {
    s_rows[s_row_count++] = ROW_NOTICE;
  }
  s_rows[s_row_count++] = ROW_NOTIFICATIONS;
  s_rows[s_row_count++] = ROW_REVIEWS;
  s_rows[s_row_count++] = ROW_PRS;
  if (g_app.summary.builds > 0 || app_list(KIND_BUILD)->count > 0) {
    s_rows[s_row_count++] = ROW_BUILDS;
  }
#if defined(PBL_MICROPHONE)
  if (g_app.summary.repo[0]) {
    s_rows[s_row_count++] = ROW_NEW_ISSUE;
  }
#endif
  s_rows[s_row_count++] = ROW_REFRESH;
}

static int prv_row_of(HomeRow row) {
  for (int i = 0; i < s_row_count; i++) {
    if (s_rows[i] == row) {
      return i;
    }
  }
  return -1;
}

static int16_t prv_text_h(const char *text, GFont font, int16_t w) {
  return graphics_text_layout_get_content_size(text, font, GRect(0, 0, w, 1000),
                                               GTextOverflowModeWordWrap,
                                               GTextAlignmentCenter).h;
}

static int16_t prv_body_w(void) {
  return layer_get_bounds(menu_layer_get_layer(s_menu)).size.w - 2 * MARGIN;
}

static const char *prv_message(void) {
  if (g_app.have_summary) {
    return SIGN_IN;
  }
  return g_app.connected ? WAITING : NO_PHONE;
}

// ---------------------------------------------------------------- header

static void prv_header_update(Layer *layer, GContext *ctx) {
  char label[32] = "INBOX";
  char title[LOGIN_MAX + 2] = "";
  GColor label_colour = ACCENT;
  if (!g_app.connected) {
    ib_copy(label, "NO PHONE", sizeof(label));
    label_colour = WARN_COLOUR;
  } else if (g_app.updated > 0 && !updated_is_fresh() && !app_signed_out()) {
    format_updated(label, sizeof(label), g_app.updated, true);
    label_colour = WARN_COLOUR;
  }
  if (g_app.summary.login[0]) {
    snprintf(title, sizeof(title), "@%s", g_app.summary.login);
  } else if (g_app.have_summary) {
    ib_copy(title, "Not signed in", sizeof(title));
  }
  header_draw(ctx, layer_get_bounds(layer), BAND_COLOUR, label_colour, GColorWhite, MARK_ICON,
              label, title);
}

// ---------------------------------------------------------------- rows

static uint16_t prv_num_rows(MenuLayer *menu, uint16_t section, void *context) {
  return s_row_count ? s_row_count : 1;
}

static int16_t prv_separator_h(MenuLayer *menu, MenuIndex *index, void *context) {
  return 0;
}

static int16_t prv_row_h(MenuLayer *menu, MenuIndex *index, void *context) {
  if (!s_row_count) {
    return layer_get_bounds(menu_layer_get_layer(menu)).size.h;
  }
  if (s_rows[index->row] == ROW_NOTICE) {
    return prv_text_h(g_app.notice, s_notice_font, prv_body_w()) + 10;
  }
  return ROW_H;
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

static void prv_badge_text(char *buf, size_t size, uint16_t n) {
  if (n > 99) {
    ib_copy(buf, "99+", size);
  } else {
    snprintf(buf, size, "%u", n);
  }
}

static int16_t prv_badge_w(const char *text) {
  const int16_t w = graphics_text_layout_get_content_size(
      text, s_badge_font, GRect(0, 0, 100, 30), GTextOverflowModeFill, GTextAlignmentLeft).w +
      2 * BADGE_PAD;
  return w < BADGE_MIN_W ? BADGE_MIN_W : w;
}

/** A count in a rounded box: blue, or red when something is failing. On black-and-white
 * watches an outline, or filled when something is failing. */
static void prv_badge(GContext *ctx, GRect box, const char *text, bool bad, bool highlighted) {
#if defined(PBL_COLOR)
  const GColor fill = bad ? (highlighted ? GColorDarkCandyAppleRed : GColorRed)
                          : (highlighted ? ACCENT_ON_WHITE : ACCENT);
  graphics_context_set_fill_color(ctx, fill);
  graphics_fill_rect(ctx, box, 5, GCornersAll);
  graphics_context_set_text_color(ctx, bad || highlighted ? GColorWhite : GColorBlack);
#else
  const GColor ink = highlighted ? GColorBlack : GColorWhite;
  if (bad) {
    graphics_context_set_fill_color(ctx, ink);
    graphics_fill_rect(ctx, box, 5, GCornersAll);
    graphics_context_set_text_color(ctx, highlighted ? GColorWhite : GColorBlack);
  } else {
    graphics_context_set_stroke_color(ctx, ink);
    graphics_draw_round_rect(ctx, box, 5);
    graphics_draw_round_rect(ctx, grect_inset(box, GEdgeInsets(1)), 4);
    graphics_context_set_text_color(ctx, ink);
  }
#endif
  graphics_draw_text(ctx, text, s_badge_font, GRect(box.origin.x, box.origin.y - 3, box.size.w,
                                                    box.size.h),
                     GTextOverflowModeFill, GTextAlignmentCenter, NULL);
}

/** A row's name, words and count (0 for no badge). */
static void prv_row_content(HomeRow row, const char **title, char *sub, size_t size,
                            uint16_t *count, bool *bad) {
  const Summary *s = &g_app.summary;
  *count = 0;
  *bad = false;
  sub[0] = '\0';
  switch (row) {
    case ROW_NOTIFICATIONS:
      *title = "Notifications";
      format_count(sub, size, KIND_NOTIFICATION, false);
      *count = s->unread;
      break;
    case ROW_REVIEWS:
      *title = "Reviews";
      format_count(sub, size, KIND_REVIEW, false);
      *count = s->reviews;
      break;
    case ROW_PRS:
      *title = "My pull requests";
      format_count(sub, size, KIND_PR, false);
      *count = s->prs;
      *bad = s->failing > 0;
      break;
    case ROW_BUILDS:
      *title = "Builds";
      format_count(sub, size, KIND_BUILD, false);
      *count = s->builds;
      *bad = s->broken > 0;
      break;
    case ROW_NEW_ISSUE:
      *title = "New issue";
      snprintf(sub, size, "to %s", s->repo);
      break;
    default:
      *title = "Refresh";
      if (g_app.updated > 0) {
        format_updated(sub, size, g_app.updated, false);
      } else {
        ib_copy(sub, "Read GitHub again now", size);
      }
      break;
  }
}

static void prv_draw_entry(GContext *ctx, const Layer *cell, HomeRow row, bool highlighted) {
  const GRect bounds = layer_get_bounds(cell);
  const char *title;
  char sub[REPO_MAX + 8];
  uint16_t count;
  bool bad;
  prv_row_content(row, &title, sub, sizeof(sub), &count, &bad);
  char badge[6] = "";
  int16_t badge_w = 0;
  if (count > 0) {
    prv_badge_text(badge, sizeof(badge), count);
    badge_w = prv_badge_w(badge);
  }
  const GColor ink = highlighted ? GColorBlack : GColorWhite;
  const GColor dim = highlighted ? DIM_ON_WHITE : DIM_COLOUR;
#if defined(PBL_ROUND)
  // The name and its badge centred as a group, the words centred below.
  int16_t title_w = graphics_text_layout_get_content_size(
      title, s_title_font, GRect(0, 0, 300, 30), GTextOverflowModeTrailingEllipsis,
      GTextAlignmentLeft).w;
  const int16_t gap = badge_w ? 6 : 0;
  const int16_t room = bounds.size.w - 2 * ROUND_GROUP_INSET - badge_w - gap;
  if (title_w > room) {
    title_w = room;
  }
  const int16_t x = (bounds.size.w - (title_w + gap + badge_w)) / 2;
  graphics_context_set_text_color(ctx, ink);
  graphics_draw_text(ctx, title, s_title_font, GRect(x, -1, title_w + 2, 22),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  if (badge_w) {
    prv_badge(ctx, GRect(x + title_w + gap, 2, badge_w, BADGE_H - 4), badge, bad, highlighted);
  }
  graphics_context_set_text_color(ctx, dim);
  graphics_draw_text(ctx, sub, s_sub_font,
                     GRect(ROUND_INSET, 19, bounds.size.w - 2 * ROUND_INSET, 18),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
#else
  const int16_t x = MARGIN;
  const int16_t w = bounds.size.w - 2 * MARGIN - (badge_w ? badge_w + 4 : 0);
  graphics_context_set_text_color(ctx, ink);
  graphics_draw_text(ctx, title, s_title_font, GRect(x, -3, w, 22),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  graphics_context_set_text_color(ctx, dim);
  graphics_draw_text(ctx, sub, s_sub_font, GRect(x, 16, w, 18),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  if (badge_w) {
    prv_badge(ctx, GRect(bounds.size.w - MARGIN - badge_w, (bounds.size.h - BADGE_H) / 2,
                         badge_w, BADGE_H),
              badge, bad, highlighted);
  }
#endif
}

static void prv_draw_row(GContext *ctx, const Layer *cell, MenuIndex *index, void *context) {
  const GRect bounds = layer_get_bounds(cell);
  if (!s_row_count) {
    prv_draw_message(ctx, bounds, prv_message());
    return;
  }
  const HomeRow row = s_rows[index->row];
  if (row == ROW_NOTICE) {
    // Not something to open, so not white when selected.
    graphics_context_set_fill_color(ctx, GColorBlack);
    graphics_fill_rect(ctx, bounds, 0, GCornerNone);
    graphics_context_set_text_color(ctx, WARN_COLOUR);
    graphics_draw_text(ctx, g_app.notice, s_notice_font,
                       GRect(MARGIN, 2, bounds.size.w - 2 * MARGIN, bounds.size.h),
                       GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
    return;
  }
  prv_draw_entry(ctx, cell, row, menu_cell_layer_is_highlighted(cell));
}

static void prv_select(MenuLayer *menu, MenuIndex *index, void *context) {
  if (!s_row_count) {
    return;
  }
  switch (s_rows[index->row]) {
    case ROW_NOTIFICATIONS:
      list_window_push(KIND_NOTIFICATION);
      break;
    case ROW_REVIEWS:
      list_window_push(KIND_REVIEW);
      break;
    case ROW_PRS:
      list_window_push(KIND_PR);
      break;
    case ROW_BUILDS:
      list_window_push(KIND_BUILD);
      break;
    case ROW_NEW_ISSUE: {
      // More than one repository to choose from: pick one first.
      const List *repos = app_list(KIND_REPO);
      if (repos->count > 1) {
        list_window_push(KIND_REPO);
      } else {
        act_new_issue(repos->count == 1 && repos->items[0].id[0] ? repos->items[0].id
                                                                  : g_app.summary.repo);
      }
      break;
    }
    case ROW_REFRESH:
      act_simple(ACT_REFRESH, "");
      break;
    default:
      break;
  }
}

static void prv_selection_changed(MenuLayer *menu, MenuIndex new_index, MenuIndex old_index,
                                  void *context) {
  if (s_row_count && new_index.row < s_row_count) {
    s_selected = s_rows[new_index.row];
  }
}

// ---------------------------------------------------------------- window

static void prv_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  const GRect bounds = layer_get_bounds(root);
  window_set_background_color(window, GColorBlack);

  s_title_font = fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);
  s_sub_font = fonts_get_system_font(FONT_KEY_GOTHIC_14);
  s_badge_font = fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);
  s_notice_font = fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD);
  s_message_font = fonts_get_system_font(FONT_KEY_GOTHIC_18);
  prv_layout();

  s_menu = menu_layer_create(GRect(0, HEADER_H, bounds.size.w, bounds.size.h - HEADER_H));
  // Not centre-focused, on round too: the list starts under the band (as London Lines).
  menu_layer_set_center_focused(s_menu, false);
  menu_layer_set_normal_colors(s_menu, GColorBlack, GColorWhite);
  menu_layer_set_highlight_colors(s_menu, GColorWhite, GColorBlack);
  menu_layer_set_callbacks(s_menu, NULL, (MenuLayerCallbacks) {
    .get_num_rows = prv_num_rows,
    .get_cell_height = prv_row_h,
    .get_separator_height = prv_separator_h,
    .draw_row = prv_draw_row,
    .select_click = prv_select,
    .selection_changed = prv_selection_changed,
  });
  menu_layer_set_click_config_onto_window(s_menu, window);
  layer_add_child(root, menu_layer_get_layer(s_menu));
  const int row = prv_row_of(s_selected);
  if (row > 0) {
    menu_layer_set_selected_index(s_menu, MenuIndex(0, row), MenuRowAlignNone, false);
  }

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

void home_window_push(void) {
  if (!s_window) {
    s_window = window_create();
    window_set_window_handlers(s_window, (WindowHandlers) {
      .load = prv_load,
      .unload = prv_unload,
    });
  }
  window_stack_push(s_window, true);
}

void home_window_destroy(void) {
  if (s_window) {
    window_destroy(s_window);
    s_window = NULL;
  }
}

/** New counts, a notice, a new time or a change of connection: redraw, keeping the same row
 * selected when rows come or go above it. */
void home_refresh(void) {
  if (!s_menu) {
    return;
  }
  const HomeRow keep = s_selected;
  prv_layout();
  menu_layer_reload_data(s_menu);
  if (s_row_count) {
    int row = prv_row_of(keep);
    if (row < 0) {
      row = prv_row_of(ROW_NOTIFICATIONS);
    }
    if (row >= 0) {
      if (row != menu_layer_get_selected_index(s_menu).row) {
        menu_layer_set_selected_index(s_menu, MenuIndex(0, row), MenuRowAlignNone, false);
      }
      s_selected = s_rows[row];
    }
  }
  if (s_header) {
    layer_mark_dirty(s_header);
  }
}
