// Acting on things: the confirm window for rerunning failed jobs and for marking all read (hold
// Select; a tap only says to hold it), dictation for a reply or a new issue (with the system's own
// confirmation of what was heard), and the result window: 'Sending…' while the phone runs the
// plugin's action, then what came of it, with a short vibe (two on failure), for 3 s.
//
// One action at a time. Its timer only runs while there's something to wait for: the phone's
// answer (30 s at most), then the 3 s the result stays up. Back leaves the result window early;
// an answer still on its way then brings it back.
#include "inbox.h"

#define HOLD_MS 600
#define ANSWER_MS 30000
#define RESULT_MS 3000
#define QUESTION_MAX 160

typedef enum { STAGE_IDLE, STAGE_SENDING, STAGE_DONE } Stage;

// Confirming.
static Window *s_confirm_window;
static Layer *s_confirm_canvas;
static uint8_t s_confirm_act;
static char *s_confirm_id;
static char s_question[QUESTION_MAX];
static bool s_nudged;  // Select was tapped, not held

// The result.
static Window *s_result_window;
static Layer *s_result_canvas;
static Stage s_stage;
static uint8_t s_act;
static char *s_act_id;
static bool s_ok;
static char s_message[NOTICE_MAX + 1];
static AppTimer *s_timer;

// Dictating.
#if defined(PBL_MICROPHONE) && !defined(IFG_FAKE_DICTATION)
static DictationSession *s_dictation;
#endif
static uint8_t s_dictate_act;
static char *s_dictate_target;  // the item replied to, or the repository for a new issue

static const char *prv_sending_text(uint8_t act) {
  switch (act) {
    case ACT_MARK_READ: return "Marking it read\xe2\x80\xa6";
    case ACT_MARK_DONE: return "Marking it done\xe2\x80\xa6";
    case ACT_MARK_ALL_READ: return "Marking all read\xe2\x80\xa6";
    case ACT_RERUN: return "Asking for a rerun\xe2\x80\xa6";
    case ACT_COMMENT: return "Sending your reply\xe2\x80\xa6";
    case ACT_NEW_ISSUE: return "Opening the issue\xe2\x80\xa6";
    case ACT_REFRESH: return "Reading GitHub\xe2\x80\xa6";
    default: return "Sending\xe2\x80\xa6";
  }
}

/** What to say when it worked and the phone didn't say what happened. */
static const char *prv_done_text(uint8_t act) {
  switch (act) {
    case ACT_MARK_READ: return "Marked read";
    case ACT_MARK_DONE: return "Marked done";
    case ACT_MARK_ALL_READ: return "All marked read";
    case ACT_RERUN: return "Rerunning failed jobs";
    case ACT_COMMENT: return "Reply posted";
    case ACT_NEW_ISSUE: return "Issue opened";
    case ACT_REFRESH: return "Up to date";
    default: return "Done";
  }
}

// ---------------------------------------------------------------- the result window

static void prv_timer_fired(void *context);

static void prv_timer(uint32_t ms) {
  if (!s_timer || !app_timer_reschedule(s_timer, ms)) {
    s_timer = app_timer_register(ms, prv_timer_fired, NULL);
  }
}

static void prv_timer_cancel(void) {
  if (s_timer) {
    app_timer_cancel(s_timer);
    s_timer = NULL;
  }
}

/** The mark above the words, the two centred as a block; smaller words when there are many. */
static void prv_result_update(Layer *layer, GContext *ctx) {
  const GRect bounds = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);
  const uint8_t mark = s_stage == STAGE_SENDING ? STATE_PENDING : s_ok ? STATE_GOOD : STATE_BAD;
  const int16_t r = bounds.size.w > 150 ? 22 : 17;
  const int16_t gap = 8;
  const int16_t inset = PBL_IF_ROUND_ELSE(bounds.size.w / 9, 8);
  const int16_t w = bounds.size.w - 2 * inset;
  const int16_t room = bounds.size.h - 2 * r - gap - PBL_IF_ROUND_ELSE(bounds.size.h / 5, 16);
  static const char *const FONTS[] = {FONT_KEY_GOTHIC_24_BOLD, FONT_KEY_GOTHIC_18_BOLD,
                                      FONT_KEY_GOTHIC_18, FONT_KEY_GOTHIC_14};
  GFont font = NULL;
  int16_t text_h = 0;
  for (unsigned i = 0; i < ARRAY_LENGTH(FONTS); i++) {
    font = fonts_get_system_font(FONTS[i]);
    text_h = graphics_text_layout_get_content_size(s_message, font, GRect(0, 0, w, 1000),
                                                   GTextOverflowModeWordWrap,
                                                   GTextAlignmentCenter).h;
    if (text_h <= room) {
      break;
    }
  }
  const int16_t top = (bounds.size.h - (2 * r + gap + text_h)) / 2;
  draw_mark(ctx, GPoint(bounds.size.w / 2, top + r), r, mark, state_colour(mark, false));
  graphics_context_set_text_color(ctx, GColorWhite);
  graphics_draw_text(ctx, s_message, font, GRect(inset, top + 2 * r + gap - 4, w, text_h + 8),
                     GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
}

static void prv_result_select(ClickRecognizerRef recognizer, void *context) {
  if (s_stage == STAGE_DONE) {
    window_stack_remove(s_result_window, true);
  }
}

static void prv_result_click_config(void *context) {
  window_single_click_subscribe(BUTTON_ID_SELECT, prv_result_select);
}

static void prv_result_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  window_set_background_color(window, GColorBlack);
  s_result_canvas = layer_create(layer_get_bounds(root));
  layer_set_update_proc(s_result_canvas, prv_result_update);
  layer_add_child(root, s_result_canvas);
}

static void prv_result_unload(Window *window) {
  layer_destroy(s_result_canvas);
  s_result_canvas = NULL;
  if (s_stage == STAGE_DONE) {
    prv_timer_cancel();  // read, or dismissed: nothing more to wait for
    s_stage = STAGE_IDLE;
  }
}

static void prv_result_show(void) {
  if (!s_result_window) {
    s_result_window = window_create();
    window_set_click_config_provider(s_result_window, prv_result_click_config);
    window_set_window_handlers(s_result_window, (WindowHandlers) {
      .load = prv_result_load,
      .unload = prv_result_unload,
    });
  }
  if (window_stack_contains_window(s_result_window)) {
    if (s_result_canvas) {
      layer_mark_dirty(s_result_canvas);
    }
  } else {
    window_stack_push(s_result_window, true);
  }
}

/** What came of it, for RESULT_MS. */
static void prv_show_done(bool ok, const char *message) {
  s_stage = STAGE_DONE;
  s_ok = ok;
  ib_copy(s_message, message, sizeof(s_message));
  if (ok) {
    vibes_short_pulse();
  } else {
    vibes_double_pulse();
  }
  prv_result_show();
  prv_timer(RESULT_MS);
}

static void prv_timer_fired(void *context) {
  s_timer = NULL;
  if (s_stage == STAGE_SENDING) {
    act_result(s_act, false, "Your phone didn't answer");
  } else if (s_stage == STAGE_DONE) {
    s_stage = STAGE_IDLE;
    if (s_result_window && window_stack_contains_window(s_result_window)) {
      window_stack_remove(s_result_window, true);
    }
  }
}

/** Sends an action to the phone and shows 'Sending…' until it says how it went. */
static void prv_start(uint8_t act, const char *id, const char *text, const char *repo) {
  if (s_stage == STAGE_SENDING) {
    prv_result_show();  // one at a time: the one on its way
    return;
  }
  free(s_act_id);
  s_act_id = ib_strndup(id, ID_MAX);
  s_act = act;
  s_ok = false;
  s_stage = STAGE_SENDING;
  ib_copy(s_message, prv_sending_text(act), sizeof(s_message));
  prv_result_show();
  prv_timer(ANSWER_MS);
  if (!app_send_act(act, id, text, repo)) {
    act_result(act, false, g_app.connected ? "Couldn't reach your phone"
                                           : "Your phone isn't connected");
  }
}

void act_result(uint8_t act, bool ok, const char *notice) {
  if (s_stage != STAGE_SENDING || act != s_act) {
    return;  // not what's being waited for (or no longer)
  }
  if (ok) {
    // What the phone's next lists will say anyway, shown now.
    switch (act) {
      case ACT_MARK_READ:
        app_mark_read(s_act_id);
        break;
      case ACT_MARK_DONE:
        app_mark_done(s_act_id);
        detail_window_close();
        break;
      case ACT_MARK_ALL_READ:
        app_mark_all_read();
        break;
      default:
        break;
    }
  }
  prv_show_done(ok, notice && notice[0] ? notice : ok ? prv_done_text(act) : "That didn't work");
}

void act_connection(bool connected) {
  if (!connected && s_stage == STAGE_SENDING) {
    act_result(s_act, false, "Your phone disconnected");
  }
}

void act_simple(uint8_t act, const char *id) {
  prv_start(act, id, NULL, NULL);
}

// ---------------------------------------------------------------- confirming

static void prv_confirm_update(Layer *layer, GContext *ctx) {
  const GRect bounds = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);
  // Beside the Select button, a ✓ on the app's blue, like an action bar's.
#if defined(PBL_ROUND)
  const GPoint at = GPoint(bounds.size.w - 18, bounds.size.h / 2);
  graphics_context_set_fill_color(ctx, ACCENT);
  graphics_fill_circle(ctx, at, 13);
  draw_mark(ctx, at, 9, STATE_GOOD, ink_on(ACCENT));
  const int16_t x = bounds.size.w / 7;
  const int16_t w = bounds.size.w - x - 36;
  const GTextAlignment align = GTextAlignmentCenter;
#else
  const int16_t bar_w = 24;
  graphics_context_set_fill_color(ctx, ACCENT);
  graphics_fill_rect(ctx, GRect(bounds.size.w - bar_w, 0, bar_w, bounds.size.h), 0, GCornerNone);
  draw_mark(ctx, GPoint(bounds.size.w - bar_w / 2, bounds.size.h / 2), 9, STATE_GOOD,
            ink_on(ACCENT));
  const int16_t x = 6;
  const int16_t w = bounds.size.w - bar_w - 2 * x;
  const GTextAlignment align = GTextAlignmentLeft;
#endif
  const char *hint = s_nudged ? "Keep holding Select" : "Hold Select";
  GFont font = fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD);
  const GFont hint_font = fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);
  const int16_t hint_h = 22;
  int16_t h = graphics_text_layout_get_content_size(s_question, font, GRect(0, 0, w, 1000),
                                                    GTextOverflowModeWordWrap, align).h;
  if (h + hint_h > bounds.size.h - PBL_IF_ROUND_ELSE(bounds.size.h / 4, 12)) {
    font = fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);
    h = graphics_text_layout_get_content_size(s_question, font, GRect(0, 0, w, 1000),
                                              GTextOverflowModeWordWrap, align).h;
  }
  const int16_t top = (bounds.size.h - (h + 6 + hint_h)) / 2 - 4;
  graphics_context_set_text_color(ctx, GColorWhite);
  graphics_draw_text(ctx, s_question, font, GRect(x, top, w, h + 8), GTextOverflowModeWordWrap,
                     align, NULL);
  graphics_context_set_text_color(ctx, WARN_COLOUR);
  graphics_draw_text(ctx, hint, hint_font, GRect(x, top + h + 6, w, hint_h + 4),
                     GTextOverflowModeTrailingEllipsis, align, NULL);
}

static void prv_nudge(ClickRecognizerRef recognizer, void *context) {
  if (!s_nudged) {
    s_nudged = true;
    layer_mark_dirty(s_confirm_canvas);
  }
}

static void prv_confirmed(ClickRecognizerRef recognizer, void *context) {
  char *id = s_confirm_id;
  s_confirm_id = NULL;
  prv_start(s_confirm_act, id ? id : "", NULL, NULL);
  free(id);
  // Back from the result goes to where the question was asked from.
  window_stack_remove(s_confirm_window, false);
}

static void prv_confirm_click_config(void *context) {
  window_single_click_subscribe(BUTTON_ID_SELECT, prv_nudge);
  window_long_click_subscribe(BUTTON_ID_SELECT, HOLD_MS, prv_confirmed, NULL);
}

static void prv_confirm_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  window_set_background_color(window, GColorBlack);
  s_confirm_canvas = layer_create(layer_get_bounds(root));
  layer_set_update_proc(s_confirm_canvas, prv_confirm_update);
  layer_add_child(root, s_confirm_canvas);
}

static void prv_confirm_unload(Window *window) {
  layer_destroy(s_confirm_canvas);
  s_confirm_canvas = NULL;
}

static void prv_confirm_push(uint8_t act, const char *id) {
  if (s_confirm_canvas) {
    return;  // already asking
  }
  s_confirm_act = act;
  free(s_confirm_id);
  s_confirm_id = ib_strndup(id, ID_MAX);
  s_nudged = false;
  if (!s_confirm_window) {
    s_confirm_window = window_create();
    window_set_click_config_provider(s_confirm_window, prv_confirm_click_config);
    window_set_window_handlers(s_confirm_window, (WindowHandlers) {
      .load = prv_confirm_load,
      .unload = prv_confirm_unload,
    });
  }
  window_stack_push(s_confirm_window, true);
}

void act_confirm_rerun(const char *id) {
  // 'acme/api#42' reads 'acme/api #42'.
  char where[ID_MAX + 2];
  size_t at = 0;
  for (const char *c = id; *c && at < sizeof(where) - 2; c++) {
    if (*c == '#' && at > 0 && where[at - 1] != ' ') {
      where[at++] = ' ';
    }
    where[at++] = *c;
  }
  where[at] = '\0';
  snprintf(s_question, sizeof(s_question), "Rerun failed jobs on %s?", where);
  prv_confirm_push(ACT_RERUN, id);
}

void act_confirm_mark_all(void) {
  const int unread = g_app.summary.unread ? g_app.summary.unread : list_unread(KIND_NOTIFICATION);
  if (unread == 1) {
    ib_copy(s_question, "Mark your unread notification read?", sizeof(s_question));
  } else if (unread > 1) {
    snprintf(s_question, sizeof(s_question), "Mark all %d notifications read?", unread);
  } else {
    ib_copy(s_question, "Mark every notification read?", sizeof(s_question));
  }
  prv_confirm_push(ACT_MARK_ALL_READ, "");
}

// ---------------------------------------------------------------- dictating

#if defined(PBL_MICROPHONE) || defined(IFG_FAKE_DICTATION)
static void prv_dictated(DictationSession *session, DictationSessionStatus status,
                         char *transcription, void *context) {
  if (status != DictationSessionStatusSuccess || !transcription) {
    return;  // cancelled, or the system has said what went wrong
  }
  while (*transcription == ' ') {
    transcription++;
  }
  if (!*transcription || !s_dictate_target) {
    return;
  }
  if (s_dictate_act == ACT_COMMENT) {
    prv_start(ACT_COMMENT, s_dictate_target, transcription, NULL);
  } else {
    list_close_picker();
    prv_start(ACT_NEW_ISSUE, "", transcription, s_dictate_target);
  }
}
#endif

static void prv_dictate(uint8_t act, const char *target) {
  if (s_stage == STAGE_SENDING) {
    prv_result_show();  // one at a time
    return;
  }
  s_dictate_act = act;
  free(s_dictate_target);
  s_dictate_target = ib_strndup(target, act == ACT_COMMENT ? ID_MAX : REPO_MAX);
#if defined(IFG_FAKE_DICTATION)
  // Debug build (wscript): the emulator can't dictate, so this stands in for what was said.
  static char fake[] = IFG_FAKE_DICTATION;
  prv_dictated(NULL, DictationSessionStatusSuccess, fake, NULL);
#elif defined(PBL_MICROPHONE)
  if (!s_dictation) {
    s_dictation = dictation_session_create(DICTATION_MAX + 1, prv_dictated, NULL);
  }
  if (!s_dictation) {
    prv_show_done(false, g_app.connected ? "Dictation isn't available"
                                         : "Your phone isn't connected");
    return;
  }
  dictation_session_enable_confirmation(s_dictation, true);
  dictation_session_start(s_dictation);
#else
  prv_show_done(false, "Dictation isn't available");
#endif
}

void act_reply(const char *id) {
  prv_dictate(ACT_COMMENT, id);
}

void act_new_issue(const char *repo) {
  prv_dictate(ACT_NEW_ISSUE, repo);
}

void act_deinit(void) {
  prv_timer_cancel();
#if defined(PBL_MICROPHONE) && !defined(IFG_FAKE_DICTATION)
  if (s_dictation) {
    dictation_session_destroy(s_dictation);
    s_dictation = NULL;
  }
#endif
  if (s_confirm_window) {
    window_destroy(s_confirm_window);
    s_confirm_window = NULL;
  }
  if (s_result_window) {
    window_destroy(s_result_window);
    s_result_window = NULL;
  }
  free(s_confirm_id);
  free(s_act_id);
  free(s_dictate_target);
  s_confirm_id = s_act_id = s_dictate_target = NULL;
}
