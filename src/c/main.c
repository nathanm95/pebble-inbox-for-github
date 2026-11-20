// Inbox for GitHub: the user's GitHub inbox from this pbw's own plugin, which the phone
// (src/pkjs/index.js) sends as a SUMMARY (the counts on Home), then each Kind's list one ITEM per
// AppMessage (Kind, Index and Count, Id, Title, Sub, State, Flags, Group, Text), then the time
// GitHub was read. A Kind's list is replaced once its whole batch is here. The summary is saved,
// so the next launch opens Home on the last counts straight away, phone or no phone.
//
// It only works while it's open. The phone reads GitHub every minute or two and sends what
// changed; the watch asks for everything (HELLO) when it starts and whenever the phone comes back
// (and again on the minute until the phone has answered), and redraws once a minute so the header
// can say when what it shows is getting old. Actions go to the phone as one ACT at a time; the
// RESULT comes back to act.c.
#include "inbox.h"

// The biggest ITEM the phone sends (DESIGN.md limits, every number an Int32) is about 670 bytes.
#define INBOX_SIZE 1024
// An ACT with the longest Id (127 bytes) and dictated Text (400) is 560 bytes; DESIGN.md's 512 is
// a little short of that.
#define OUTBOX_SIZE 576

App g_app;

// The most of each Kind the phone sends (DESIGN.md "Lists"); more is dropped.
static const uint8_t CAPS[KIND_COUNT] = {15, 8, 8, 6, 6};

// Each Kind's batch on its way. A newer batch of a Kind can start before the older one is whole
// (the phone drops what's left of the older one), and batches of different Kinds can interleave.
typedef struct {
  Item *items;     // calloc'd to count
  uint8_t count;
  uint32_t have;   // bit i: item i has come
} Incoming;

static Incoming s_incoming[KIND_COUNT];

// The outbox: a HELLO, or the one ACT on its way (its strings copied, freed once it's gone).
static bool s_sending;
static bool s_sending_act;
static bool s_want_hello;
static struct {
  bool want;
  uint8_t act;
  char *id;
  char *text;
  char *repo;
} s_act;

static void prv_refresh_all(void) {
  home_refresh();
  list_refresh(0);
  detail_refresh();
}

// ---------------------------------------------------------------- sending

static void prv_act_free(void) {
  free(s_act.id);
  free(s_act.text);
  free(s_act.repo);
  s_act.id = s_act.text = s_act.repo = NULL;
  s_act.want = false;
}

static void prv_act_failed(void) {
  const uint8_t act = s_act.act;
  prv_act_free();
  act_result(act, false, "Couldn't reach your phone");
}

/** Sends what the phone should have next, if the outbox is free: the ACT, then a HELLO. */
static void prv_pump(void) {
  if (s_sending || !g_app.connected) {
    return;
  }
  DictionaryIterator *it;
  if (s_act.want) {
    if (app_message_outbox_begin(&it) != APP_MSG_OK || !it) {
      prv_act_failed();
      return;
    }
    dict_write_uint8(it, MESSAGE_KEY_Cmd, CMD_ACT);
    dict_write_uint8(it, MESSAGE_KEY_Act, s_act.act);
    dict_write_cstring(it, MESSAGE_KEY_Id, s_act.id ? s_act.id : "");
    if (s_act.text) {
      dict_write_cstring(it, MESSAGE_KEY_Text, s_act.text);
    }
    if (s_act.repo) {
      dict_write_cstring(it, MESSAGE_KEY_Repo, s_act.repo);
    }
    if (app_message_outbox_send() != APP_MSG_OK) {
      prv_act_failed();
      return;
    }
    s_sending = true;
    s_sending_act = true;
    return;
  }
  if (s_want_hello) {
    if (app_message_outbox_begin(&it) != APP_MSG_OK || !it) {
      return;  // tried again on the minute
    }
    dict_write_uint8(it, MESSAGE_KEY_Cmd, CMD_HELLO);
    if (app_message_outbox_send() == APP_MSG_OK) {
      s_want_hello = false;
      s_sending = true;
      s_sending_act = false;
    }
  }
}

bool app_send_act(uint8_t act, const char *id, const char *text, const char *repo) {
  if (!g_app.connected || s_act.want || (s_sending && s_sending_act)) {
    return false;
  }
  s_act.act = act;
  s_act.id = ib_strndup(id, ID_MAX);
  s_act.text = text ? ib_strndup(text, DICTATION_MAX) : NULL;
  s_act.repo = repo ? ib_strndup(repo, REPO_MAX) : NULL;
  s_act.want = true;
  prv_pump();
  return true;
}

static void prv_sent(DictionaryIterator *it, void *context) {
  if (s_sending_act) {
    prv_act_free();  // the RESULT says how it went
  }
  s_sending = s_sending_act = false;
  prv_pump();
}

static void prv_failed(DictionaryIterator *it, AppMessageResult reason, void *context) {
  const bool was_act = s_sending_act;
  s_sending = s_sending_act = false;
  if (was_act) {
    prv_act_failed();
  }
  // A HELLO that didn't go is sent again on the minute until the phone answers.
  prv_pump();
}

// ---------------------------------------------------------------- what the windows change

/** A notification marked read: no longer unread here, before the phone's next list says so. */
void app_mark_read(const char *id) {
  Item *item = list_find(KIND_NOTIFICATION, id);
  if (item && (item->flags & FLAG_UNREAD)) {
    item->flags &= ~FLAG_UNREAD;
    if (g_app.summary.unread > 0) {
      g_app.summary.unread--;
    }
  }
  prv_refresh_all();
}

/** A notification marked done: out of the list. */
void app_mark_done(const char *id) {
  List *list = app_list(KIND_NOTIFICATION);
  Item *item = list_find(KIND_NOTIFICATION, id);
  if (item) {
    if ((item->flags & FLAG_UNREAD) && g_app.summary.unread > 0) {
      g_app.summary.unread--;
    }
    const int index = item - list->items;
    item_free(item);
    memmove(&list->items[index], &list->items[index + 1],
            (list->count - index - 1) * sizeof(Item));
    list->count--;
    list->items[list->count] = (Item){0};
  }
  prv_refresh_all();
}

void app_mark_all_read(void) {
  List *list = app_list(KIND_NOTIFICATION);
  for (int i = 0; i < list->count; i++) {
    list->items[i].flags &= ~FLAG_UNREAD;
  }
  g_app.summary.unread = 0;
  prv_refresh_all();
}

// ---------------------------------------------------------------- receiving

static int32_t prv_int(const Tuple *t) {
  if (!t) {
    return 0;
  }
  if (t->type == TUPLE_INT) {
    return t->length == 1 ? t->value->int8 : t->length == 2 ? t->value->int16 : t->value->int32;
  }
  if (t->type == TUPLE_UINT) {
    return t->length == 1 ? t->value->uint8 : t->length == 2 ? t->value->uint16
                                                             : (int32_t)t->value->uint32;
  }
  return 0;
}

static const char *prv_str(const Tuple *t) {
  return t && t->type == TUPLE_CSTRING && t->length > 0 ? t->value->cstring : "";
}

static uint16_t prv_count(DictionaryIterator *it, uint32_t key) {
  const int32_t n = prv_int(dict_find(it, key));
  return n < 0 ? 0 : n > 9999 ? 9999 : n;
}

static void prv_incoming_free(Incoming *in) {
  if (in->items) {
    for (int i = 0; i < in->count; i++) {
      item_free(&in->items[i]);
    }
    free(in->items);
  }
  *in = (Incoming){0};
}

/** A Kind's whole batch is here (or it's empty): show it. */
static void prv_take(uint8_t kind) {
  Incoming *in = &s_incoming[kind - 1];
  List *list = app_list(kind);
  list_free(list);
  list->items = in->items;  // the strings move with them
  list->count = in->items ? in->count : 0;
  list->have = true;
  *in = (Incoming){0};
  prv_refresh_all();
}

static void prv_item(DictionaryIterator *it) {
  const int32_t kind = prv_int(dict_find(it, MESSAGE_KEY_Kind));
  if (kind < 1 || kind > KIND_COUNT) {
    return;
  }
  Incoming *in = &s_incoming[kind - 1];
  int32_t count = prv_int(dict_find(it, MESSAGE_KEY_Count));
  if (count <= 0) {
    prv_incoming_free(in);
    prv_take(kind);  // an empty list
    return;
  }
  if (count > CAPS[kind - 1]) {
    count = CAPS[kind - 1];
  }
  const int32_t index = prv_int(dict_find(it, MESSAGE_KEY_Index));
  if (index < 0 || index >= count) {
    return;
  }
  // Item 0 starts a batch; so does a count that doesn't match the batch under way.
  if (index == 0 || count != in->count || !in->items) {
    prv_incoming_free(in);
    in->items = calloc(count, sizeof(Item));
    if (!in->items) {
      return;
    }
    in->count = count;
  }
  Item *item = &in->items[index];
  item_free(item);
  item->id = ib_strndup(prv_str(dict_find(it, MESSAGE_KEY_Id)), ID_MAX);
  item->title = ib_strndup(prv_str(dict_find(it, MESSAGE_KEY_Title)), TITLE_MAX);
  item->sub = ib_strndup(prv_str(dict_find(it, MESSAGE_KEY_Sub)), SUB_MAX);
  item->text = ib_strndup(prv_str(dict_find(it, MESSAGE_KEY_Text)), TEXT_MAX);
  item->state = prv_int(dict_find(it, MESSAGE_KEY_State));
  item->flags = prv_int(dict_find(it, MESSAGE_KEY_Flags));
  item->group = prv_int(dict_find(it, MESSAGE_KEY_Group));
  if (!item->id || !item->title || !item->sub || !item->text) {
    item_free(item);  // out of memory: the batch stays incomplete, and what's shown stays
    return;
  }
  if (item->state > STATE_DRAFT) {
    item->state = STATE_NONE;
  }
  if (item->group >= GROUP_COUNT) {
    item->group = GROUP_OTHER;
  }
  in->have |= 1u << index;
  if (in->have == (1u << count) - 1) {
    prv_take(kind);
  }
}

static void prv_summary(DictionaryIterator *it) {
  Summary s;
  memset(&s, 0, sizeof(s));  // so the saved copy compares byte for byte
  s.unread = prv_count(it, MESSAGE_KEY_Unread);
  s.reviews = prv_count(it, MESSAGE_KEY_Reviews);
  s.prs = prv_count(it, MESSAGE_KEY_Prs);
  s.failing = prv_count(it, MESSAGE_KEY_Failing);
  s.builds = prv_count(it, MESSAGE_KEY_Builds);
  s.broken = prv_count(it, MESSAGE_KEY_Broken);
  ib_copy(s.login, prv_str(dict_find(it, MESSAGE_KEY_Login)), sizeof(s.login));
  ib_copy(s.repo, prv_str(dict_find(it, MESSAGE_KEY_Repo)), sizeof(s.repo));
  g_app.summary = s;
  g_app.have_summary = true;
  summary_save(&g_app.summary, g_app.updated);
  prv_refresh_all();
}

static void prv_time(DictionaryIterator *it) {
  const time_t updated = prv_int(dict_find(it, MESSAGE_KEY_Updated));
  if (updated <= 0 || updated == g_app.updated) {
    return;
  }
  g_app.updated = updated;
  if (g_app.have_summary) {
    summary_save(&g_app.summary, g_app.updated);
  }
  prv_refresh_all();
}

static void prv_inbox(DictionaryIterator *it, void *context) {
  g_app.heard = true;
  switch (prv_int(dict_find(it, MESSAGE_KEY_Cmd))) {
    case CMD_SUMMARY:
      prv_summary(it);
      break;
    case CMD_ITEM:
      prv_item(it);
      break;
    case CMD_TIME:
      prv_time(it);
      break;
    case CMD_NOTICE:
      ib_copy(g_app.notice, prv_str(dict_find(it, MESSAGE_KEY_Notice)), sizeof(g_app.notice));
      home_refresh();
      break;
    case CMD_RESULT:
      act_result(prv_int(dict_find(it, MESSAGE_KEY_Act)),
                 prv_int(dict_find(it, MESSAGE_KEY_Ok)) != 0,
                 prv_str(dict_find(it, MESSAGE_KEY_Notice)));
      break;
  }
}

// ---------------------------------------------------------------- the app

static void prv_connection(bool connected) {
  g_app.connected = connected;
  if (connected) {
    s_want_hello = true;
    prv_pump();
  } else {
    // An ACT not yet with the phone won't get there: act_connection() says so.
    if (s_act.want || s_sending_act) {
      prv_act_free();
    }
    s_sending = s_sending_act = false;
  }
  act_connection(connected);
  home_refresh();
}

static void prv_tick(struct tm *tick_time, TimeUnits units_changed) {
  if (g_app.connected && !g_app.heard) {
    s_want_hello = true;  // the phone's JavaScript wasn't ready for the last one
    prv_pump();
  }
  home_refresh();  // 'UPDATED 15:18' once what's shown is more than a few minutes old
  list_refresh(0);
}

static void prv_init(void) {
  g_app.connected = connection_service_peek_pebble_app_connection();
  g_app.have_summary = summary_load(&g_app.summary, &g_app.updated);
  header_init();
#if defined(PBL_TOUCH)
  // Third-party apps get no touch navigation until they ask: swipes scroll the lists and an item.
  app_touch_navigation_enable(true);
#endif
  home_window_push();

  app_message_register_inbox_received(prv_inbox);
  app_message_register_outbox_sent(prv_sent);
  app_message_register_outbox_failed(prv_failed);
  app_message_open(INBOX_SIZE, OUTBOX_SIZE);
  connection_service_subscribe((ConnectionHandlers) {
    .pebble_app_connection_handler = prv_connection,
  });
  tick_timer_service_subscribe(MINUTE_UNIT, prv_tick);
  s_want_hello = true;
  prv_pump();
}

static void prv_deinit(void) {
  tick_timer_service_unsubscribe();
  connection_service_unsubscribe();
  app_message_deregister_callbacks();
  act_deinit();
  detail_window_destroy();
  list_window_destroy();
  home_window_destroy();
  header_deinit();
  for (int k = 0; k < KIND_COUNT; k++) {
    list_free(&g_app.lists[k]);
    prv_incoming_free(&s_incoming[k]);
  }
  prv_act_free();
}

int main(void) {
  prv_init();
  app_event_loop();
  prv_deinit();
}
