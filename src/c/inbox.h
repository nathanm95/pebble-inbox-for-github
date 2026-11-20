// Inbox for GitHub, the watch app: the user's GitHub notifications, review requests, pull requests
// and builds, from this pbw's own plugin (code/*), sent over by the phone (src/pkjs/index.js) one
// item per AppMessage, listed, read one at a time and acted on: mark read or done, mark all read,
// rerun failed jobs, reply or open an issue by voice. The phone runs the plugin's actions; the
// watch never talks to GitHub, and never sees the token.
#pragma once
#include <pebble.h>

// Byte limits (UTF-8, without the NUL), as DESIGN.md "Watch protocol" has them. The phone cuts to
// these at a word with '…'; the watch cuts at a whole character in case it doesn't.
#define ID_MAX 127
#define TITLE_MAX 100
#define SUB_MAX 47
#define TEXT_MAX 280
#define NOTICE_MAX 159
#define LOGIN_MAX 39
#define REPO_MAX 100
#define DICTATION_MAX 400

// The AppMessage Cmd values, the same as CMD in src/pkjs/index.js.
enum {
  CMD_HELLO = 1,    // watch -> phone: send me everything you have
  CMD_SUMMARY = 2,  // phone -> watch: the counts on Home (Login, Unread, Reviews, Prs, ...)
  CMD_ITEM = 3,     // phone -> watch: one item of a Kind's list (Kind, Index, Count, Id, ...)
  CMD_TIME = 4,     // phone -> watch: when GitHub was last read (Updated)
  CMD_NOTICE = 5,   // phone -> watch: why there's nothing new (Notice; empty clears it)
  CMD_RESULT = 6,   // phone -> watch: how an ACT went (Act, Ok, Notice)
  CMD_ACT = 7,      // watch -> phone: run one of the plugin's actions (Act, Id, Text, Repo)
};

// What a list holds (Kind). Lists are kept in g_app.lists[kind - 1].
enum {
  KIND_NOTIFICATION = 1,
  KIND_REVIEW = 2,   // pull requests waiting for the user's review
  KIND_PR = 3,       // the user's own open pull requests
  KIND_BUILD = 4,    // the default branch of each repository chosen for builds
  KIND_REPO = 5,     // the repositories chosen in settings, for a new issue
};
#define KIND_COUNT 5

// The plugin's actions (Act).
enum {
  ACT_MARK_READ = 1,
  ACT_MARK_DONE = 2,
  ACT_MARK_ALL_READ = 3,
  ACT_RERUN = 4,
  ACT_COMMENT = 5,
  ACT_NEW_ISSUE = 6,
  ACT_REFRESH = 7,
};

// How an item is doing (State): its mark in a list, the colour of its band.
enum {
  STATE_NONE = 0,     // ○ grey
  STATE_GOOD = 1,     // ✓ green: passing, approved
  STATE_PENDING = 2,  // ● amber: running, review required
  STATE_BAD = 3,      // ✗ red: failing, changes requested
  STATE_DRAFT = 4,    // dashed ○ grey
};

// Flags, as bits.
enum {
  FLAG_UNREAD = 1,
  FLAG_CAN_RERUN = 2,
  FLAG_CAN_COMMENT = 4,
  FLAG_CAN_MARK = 8,
  FLAG_DEFAULT = 16,  // a repository: where new issues go
};

// A notification's group (Group): the sections of the notifications list, in this order.
enum {
  GROUP_REVIEW = 0,
  GROUP_MENTIONED = 1,
  GROUP_ASSIGNED = 2,
  GROUP_BUILDS = 3,
  GROUP_OTHER = 4,
};
#define GROUP_COUNT 5

typedef struct {
  char *id;     // the plugin's instanceId: '1234567890' (a thread), 'acme/api#42', 'acme/api'
  char *title;  // 'Retry the upload when the token expires'
  char *sub;    // 'acme/api #42 · 3h'
  char *text;   // lines, \n between: 'Review requested · Pull request\nsam-lee: Looks good…'
  uint8_t state;
  uint8_t flags;
  uint8_t group;
} Item;

typedef struct {
  Item *items;    // malloc'd to count
  uint8_t count;
  bool have;      // a batch has come this run, even an empty one
} List;

// SUMMARY, kept as is in persistent storage (data.c), so the layout is part of PERSIST_VERSION.
typedef struct __attribute__((packed)) {
  uint16_t unread;    // unread notifications
  uint16_t reviews;   // pull requests waiting for the user's review
  uint16_t prs;       // the user's open pull requests
  uint16_t failing;   // ... of which failing
  uint16_t builds;    // repositories watched for builds
  uint16_t broken;    // ... of which failing
  char login[LOGIN_MAX + 1];  // '' when not signed in (and not in demo mode)
  char repo[REPO_MAX + 1];    // where new issues go, '' for nowhere
} Summary;

typedef struct {
  Summary summary;
  bool have_summary;             // a SUMMARY has come (or was saved)
  List lists[KIND_COUNT];
  time_t updated;                // when GitHub was last read (saved with the summary)
  bool connected;                // the phone is there
  bool heard;                    // the phone has sent something this run
  char notice[NOTICE_MAX + 1];   // the phone's last word on a problem, '' if none
} App;

extern App g_app;

// main.c: talking to the phone, and what an action that worked changes before the phone says so
bool app_send_act(uint8_t act, const char *id, const char *text, const char *repo);
void app_mark_read(const char *id);
void app_mark_done(const char *id);
void app_mark_all_read(void);

// data.c: strings, items, the saved summary
char *ib_strndup(const char *src, size_t max);
void ib_copy(char *dst, const char *src, size_t size);
uint32_t ib_hash(const char *s);
void item_free(Item *item);
void list_free(List *list);
List *app_list(uint8_t kind);
Item *list_find(uint8_t kind, const char *id);
int list_unread(uint8_t kind);
bool summary_load(Summary *summary, time_t *updated);
void summary_save(const Summary *summary, time_t updated);
bool app_signed_out(void);

// header.c: the band at the top of each window, the state marks, colours and times
#define HEADER_H PBL_IF_ROUND_ELSE((PBL_DISPLAY_WIDTH > 200 ? 64 : 58), 44)
#define MARGIN PBL_IF_ROUND_ELSE(26, 6)
#define BAND_COLOUR PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack)
#define ACCENT PBL_IF_COLOR_ELSE(GColorPictonBlue, GColorWhite)
#define ACCENT_ON_WHITE PBL_IF_COLOR_ELSE(GColorCobaltBlue, GColorBlack)
#define WARN_COLOUR PBL_IF_COLOR_ELSE(GColorChromeYellow, GColorWhite)
#define DIM_COLOUR PBL_IF_COLOR_ELSE(GColorLightGray, GColorWhite)
#define DIM_ON_WHITE PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack)
#define MARK_ICON -1  // header_draw: the inbox icon instead of a state mark
void header_init(void);
void header_deinit(void);
void header_draw(GContext *ctx, GRect bounds, GColor band, GColor label_colour, GColor ink,
                 int8_t mark, const char *label, const char *title);
bool header_title_fits(GRect bounds, const char *title);
void draw_mark(GContext *ctx, GPoint centre, int16_t r, uint8_t state, GColor colour);
GColor state_colour(uint8_t state, bool on_white);
GColor state_band(uint8_t state);
GColor ink_on(GColor band);
void format_clock(char *buf, size_t size, const struct tm *t);
void format_updated(char *buf, size_t size, time_t when, bool upper);
bool updated_is_fresh(void);
void format_count(char *buf, size_t size, uint8_t kind, bool brief);
const char *kind_label(uint8_t kind);
const char *group_label(uint8_t group);

// home.c
void home_window_push(void);
void home_window_destroy(void);
void home_refresh(void);

// list.c: one Kind's list, or the repositories to pick from for a new issue
void list_window_push(uint8_t kind);
void list_window_destroy(void);
void list_refresh(uint8_t kind);
void list_close_picker(void);

// detail.c
void detail_window_push(uint8_t kind, const Item *item);
void detail_window_destroy(void);
void detail_window_close(void);
void detail_refresh(void);

// act.c: confirming, dictating, sending, and what came of it
void act_confirm_rerun(const char *id);
void act_confirm_mark_all(void);
void act_simple(uint8_t act, const char *id);
void act_reply(const char *id);
void act_new_issue(const char *repo);
void act_result(uint8_t act, bool ok, const char *notice);
void act_connection(bool connected);
void act_deinit(void);
