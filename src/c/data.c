// The data: strings cut to their limits, items and lists, and the summary kept in persistent
// storage so Home opens with the last counts it had (and when GitHub was read), phone or no phone.
// Lists aren't kept: they come again from the phone each launch.
#include "inbox.h"

#define PERSIST_VERSION 1
#define KEY_SUMMARY 1

typedef struct __attribute__((packed)) {
  uint8_t version;
  uint8_t reserved[3];
  int32_t updated;
  Summary summary;
} Saved;

/** The most bytes of `s`, up to `n`, that end on a whole UTF-8 character. */
static size_t prv_utf8_floor(const char *s, size_t n) {
  while (n > 0 && (((uint8_t)s[n]) & 0xC0) == 0x80) {
    n--;
  }
  return n;
}

char *ib_strndup(const char *src, size_t max) {
  if (!src) {
    src = "";
  }
  size_t len = strlen(src);
  if (len > max) {
    len = prv_utf8_floor(src, max);
  }
  char *out = malloc(len + 1);
  if (out) {
    memcpy(out, src, len);
    out[len] = '\0';
  }
  return out;
}

void ib_copy(char *dst, const char *src, size_t size) {
  if (!src) {
    src = "";
  }
  size_t len = strlen(src);
  if (len > size - 1) {
    len = prv_utf8_floor(src, size - 1);
  }
  memcpy(dst, src, len);
  dst[len] = '\0';
}

/** FNV-1a, to remember the selected item without keeping a copy of its id. */
uint32_t ib_hash(const char *s) {
  uint32_t h = 2166136261u;
  for (const char *p = s ? s : ""; *p; p++) {
    h ^= (uint8_t)*p;
    h *= 16777619u;
  }
  return h;
}

void item_free(Item *item) {
  free(item->id);
  free(item->title);
  free(item->sub);
  free(item->text);
  *item = (Item){0};
}

void list_free(List *list) {
  if (list->items) {
    for (int i = 0; i < list->count; i++) {
      item_free(&list->items[i]);
    }
    free(list->items);
  }
  list->items = NULL;
  list->count = 0;
}

List *app_list(uint8_t kind) {
  return kind >= 1 && kind <= KIND_COUNT ? &g_app.lists[kind - 1] : NULL;
}

Item *list_find(uint8_t kind, const char *id) {
  List *list = app_list(kind);
  if (!list || !id || !id[0]) {
    return NULL;
  }
  for (int i = 0; i < list->count; i++) {
    if (list->items[i].id && strcmp(list->items[i].id, id) == 0) {
      return &list->items[i];
    }
  }
  return NULL;
}

int list_unread(uint8_t kind) {
  const List *list = app_list(kind);
  int n = 0;
  for (int i = 0; list && i < list->count; i++) {
    if (list->items[i].flags & FLAG_UNREAD) {
      n++;
    }
  }
  return n;
}

/** Not signed in, not in demo mode, and nothing to show from before. */
bool app_signed_out(void) {
  if (!g_app.have_summary || g_app.summary.login[0]) {
    return false;
  }
  for (int k = 0; k < KIND_COUNT; k++) {
    if (k + 1 != KIND_REPO && g_app.lists[k].count > 0) {
      return false;
    }
  }
  const Summary *s = &g_app.summary;
  return !(s->unread || s->reviews || s->prs || s->builds);
}

// ---------------------------------------------------------------- storage

bool summary_load(Summary *summary, time_t *updated) {
  Saved saved;
  if (persist_read_data(KEY_SUMMARY, &saved, sizeof(saved)) != (int)sizeof(saved) ||
      saved.version != PERSIST_VERSION) {
    return false;
  }
  // Strings from storage are trusted no further than strings from the phone.
  saved.summary.login[LOGIN_MAX] = '\0';
  saved.summary.repo[REPO_MAX] = '\0';
  *summary = saved.summary;
  *updated = saved.updated;
  return true;
}

void summary_save(const Summary *summary, time_t updated) {
  Saved saved = {
    .version = PERSIST_VERSION,
    .updated = updated,
    .summary = *summary,
  };
  Saved before;
  if (persist_read_data(KEY_SUMMARY, &before, sizeof(before)) == (int)sizeof(before) &&
      memcmp(&before, &saved, sizeof(saved)) == 0) {
    return;  // no flash write for nothing
  }
  persist_write_data(KEY_SUMMARY, &saved, sizeof(saved));
}
