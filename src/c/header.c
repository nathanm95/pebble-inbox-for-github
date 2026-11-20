// Drawing shared by the windows: the band at the top (the inbox icon or a state mark, a small bold
// label and a title below it, as in London Lines and Counters), the state marks (✓ ✗ ● ○ and a
// dashed ○), their colours, and how times read.
//
// On black-and-white watches the marks are told apart by shape alone, and the band is black, ruled
// off from the black page with a white line.
#include "inbox.h"

// Round: how wide the band's text may run, below the curve of the top edge.
#define ROUND_TEXT_MAX (PBL_DISPLAY_WIDTH > 200 ? 120 : 100)
#if defined(PBL_ROUND) && PBL_DISPLAY_WIDTH < 200
// The Time Round's band is too narrow at the top for the icon beside two lines of text, so the
// label has a line to itself, this wide at most, and the icon sits beside the title below it.
#define SMALL_ROUND 1
#define SMALL_LABEL_MAX 112
#define SMALL_ICON_GAP 5
#endif
#define ICON_SIZE 25
#define ICON_GAP 7
// What's shown is 'fresh' while GitHub was read in the last few minutes: the phone reads it every
// two at most, so this allows for one missed read.
#define FRESH_S (5 * 60)

static GBitmap *s_icon;
static GColor s_icon_ink;
static GFont s_label_font;
static GFont s_label_narrow_font;  // for a label too long for the bold
static GFont s_title_font;

void header_init(void) {
  // The launcher icon, black on clear; recoloured to the band's ink when drawn.
  s_icon = gbitmap_create_with_resource(RESOURCE_ID_MENU_ICON);
  s_icon_ink = GColorBlack;
  s_label_font = fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD);
  s_label_narrow_font = fonts_get_system_font(FONT_KEY_GOTHIC_14);
  s_title_font = fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);
}

void header_deinit(void) {
  if (s_icon) {
    gbitmap_destroy(s_icon);
    s_icon = NULL;
  }
}

/** The icon's opaque colours become `ink`, keeping their alpha. */
static void prv_icon_ink(GColor ink) {
  if (!s_icon || gcolor_equal(ink, s_icon_ink)) {
    return;
  }
  GColor *palette = gbitmap_get_palette(s_icon);
  int entries = 0;
  switch (gbitmap_get_format(s_icon)) {
    case GBitmapFormat1BitPalette: entries = 2; break;
    case GBitmapFormat2BitPalette: entries = 4; break;
    case GBitmapFormat4BitPalette: entries = 16; break;
    default: break;
  }
  for (int i = 0; palette && i < entries; i++) {
    if (palette[i].a) {
      const uint8_t alpha = palette[i].a;
      palette[i] = ink;
      palette[i].a = alpha;
    }
  }
  s_icon_ink = ink;
}

static int16_t prv_width(const char *text, GFont font) {
  if (!text || !*text) {
    return 0;
  }
  return graphics_text_layout_get_content_size(text, font, GRect(0, 0, 300, 40),
                                               GTextOverflowModeTrailingEllipsis,
                                               GTextAlignmentLeft).w;
}

/** How wide the title may be in a band this size. */
static int16_t prv_text_w(GRect bounds) {
#if defined(PBL_ROUND)
  return ROUND_TEXT_MAX;
#else
  return bounds.size.w - (6 + ICON_SIZE + ICON_GAP) - 4;
#endif
}

bool header_title_fits(GRect bounds, const char *title) {
  return prv_width(title, s_title_font) <= prv_text_w(bounds);
}

void header_draw(GContext *ctx, GRect bounds, GColor band, GColor label_colour, GColor ink,
                 int8_t mark, const char *label, const char *title) {
#if !defined(PBL_COLOR)
  band = GColorBlack;
  ink = GColorWhite;
  label_colour = GColorWhite;
#endif
  graphics_context_set_fill_color(ctx, band);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);
  const int16_t max_w = prv_text_w(bounds);
#if defined(SMALL_ROUND)
  const int16_t top = bounds.size.h - 42;
  if (label && *label) {
    const GFont font = prv_width(label, s_label_font) > SMALL_LABEL_MAX ? s_label_narrow_font
                                                                         : s_label_font;
    graphics_context_set_text_color(ctx, label_colour);
    graphics_draw_text(ctx, label, font,
                       GRect((bounds.size.w - SMALL_LABEL_MAX) / 2, top + 2, SMALL_LABEL_MAX, 16),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  }
  int16_t title_w = prv_width(title, s_title_font);
  if (title_w > max_w) {
    title_w = max_w;
  }
  const int16_t x = (bounds.size.w - (ICON_SIZE + SMALL_ICON_GAP + title_w)) / 2;
  const int16_t icon_y = top + 16;
  const int16_t text_x = x + ICON_SIZE + SMALL_ICON_GAP;
  if (title && *title) {
    graphics_context_set_text_color(ctx, ink);
    graphics_draw_text(ctx, title, s_title_font, GRect(text_x, top + 16, title_w + 2, 22),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  }
#else
  // A title too long for one line takes both, and the label gives way.
  const bool wrap = title && *title && prv_width(title, s_title_font) > max_w;
#if defined(PBL_ROUND)
  // Icon and text centred as a group, below the curve of the top edge.
  const int16_t top = bounds.size.h - 42;
  int16_t text_w;
  if (wrap) {
    text_w = graphics_text_layout_get_content_size(title, s_title_font, GRect(0, 0, max_w, 60),
                                                   GTextOverflowModeWordWrap,
                                                   GTextAlignmentLeft).w;
  } else {
    text_w = prv_width(label, s_label_font);
    const int16_t title_w = prv_width(title, s_title_font);
    if (title_w > text_w) {
      text_w = title_w;
    }
  }
  if (text_w > max_w) {
    text_w = max_w;
  }
  const int16_t x = (bounds.size.w - (ICON_SIZE + ICON_GAP + text_w)) / 2;
#else
  const int16_t top = 0;
  const int16_t x = 6;
  const int16_t text_w = max_w;
#endif
  const int16_t icon_y = top + 10;
#endif
  if (mark == MARK_ICON) {
    if (s_icon) {
      prv_icon_ink(ink);
      graphics_context_set_compositing_mode(ctx, GCompOpSet);
      graphics_draw_bitmap_in_rect(ctx, s_icon, GRect(x, icon_y, ICON_SIZE, ICON_SIZE));
      graphics_context_set_compositing_mode(ctx, GCompOpAssign);
    }
  } else {
    draw_mark(ctx, GPoint(x + ICON_SIZE / 2, icon_y + ICON_SIZE / 2), 10, mark, ink);
  }
#if !defined(SMALL_ROUND)
  const int16_t text_x = x + ICON_SIZE + ICON_GAP;
  if (wrap) {
    graphics_context_set_text_color(ctx, ink);
    graphics_draw_text(ctx, title, s_title_font, GRect(text_x, top - 1, text_w, 42),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  } else {
    if (label && *label) {
      const GFont font = prv_width(label, s_label_font) > text_w ? s_label_narrow_font
                                                                  : s_label_font;
      graphics_context_set_text_color(ctx, label_colour);
      graphics_draw_text(ctx, label, font, GRect(text_x, top + 2, text_w, 16),
                         GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    }
    if (title && *title) {
      graphics_context_set_text_color(ctx, ink);
      graphics_draw_text(ctx, title, s_title_font, GRect(text_x, top + 16, text_w, 22),
                         GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    }
  }
#endif
#if !defined(PBL_COLOR)
  // The black band would run into the black page: rule it off.
  graphics_context_set_stroke_color(ctx, GColorWhite);
  graphics_draw_line(ctx, GPoint(0, bounds.size.h - 1), GPoint(bounds.size.w, bounds.size.h - 1));
#endif
#if defined(IFG_DEBUG)
  // Debug builds only (wscript): a release build must not contain this string.
  graphics_context_set_text_color(ctx, PBL_IF_COLOR_ELSE(GColorRed, GColorWhite));
  graphics_draw_text(ctx, "DEBUG", s_label_font,
                     PBL_IF_ROUND_ELSE(GRect(0, top - 14, bounds.size.w, 16),
                                       GRect(bounds.size.w - 44, -3, 42, 16)),
                     GTextOverflowModeFill,
                     PBL_IF_ROUND_ELSE(GTextAlignmentCenter, GTextAlignmentRight), NULL);
#endif
}

// ---------------------------------------------------------------- marks

/** One of the five state marks, `r` from its centre to its edge, in `colour`: ✓ GOOD, ✗ BAD,
 * ● PENDING, ○ NONE and a dashed ○ for DRAFT. Drawn without antialiasing, so a small one stays
 * crisp and black-and-white watches get clean pixels. Lines draw only at odd widths, so a small
 * mark's 2px lines are each drawn twice, a pixel apart. */
void draw_mark(GContext *ctx, GPoint c, int16_t r, uint8_t state, GColor colour) {
  graphics_context_set_antialiased(ctx, false);
  graphics_context_set_stroke_color(ctx, colour);
  graphics_context_set_fill_color(ctx, colour);
  const bool big = r >= 9;
  const int passes = big ? 1 : 2;
  const int16_t rr = r * 3 / 4;  // the circles sit inside the ✓ and ✗
  graphics_context_set_stroke_width(ctx, big ? 3 : 1);
  switch (state) {
    case STATE_GOOD:
      // The short arm down to just left of centre, the long one up to the right.
      for (int p = 0; p < passes; p++) {
        const GPoint low = GPoint(c.x - r / 4, c.y + r * 5 / 8 + p);
        graphics_draw_line(ctx, GPoint(c.x - r * 7 / 8, c.y + p), low);
        graphics_draw_line(ctx, low, GPoint(c.x + r * 7 / 8, c.y - r * 5 / 8 + p));
      }
      break;
    case STATE_BAD:
      for (int p = 0; p < passes; p++) {
        graphics_draw_line(ctx, GPoint(c.x - rr + p, c.y - rr), GPoint(c.x + rr + p, c.y + rr));
        graphics_draw_line(ctx, GPoint(c.x - rr + p, c.y + rr), GPoint(c.x + rr + p, c.y - rr));
      }
      break;
    case STATE_PENDING:
      graphics_fill_circle(ctx, c, rr);
      break;
    case STATE_DRAFT: {
      // A ring of eight dashes (arcs do take an even width).
      graphics_context_set_stroke_width(ctx, big ? 3 : 2);
      const GRect box = GRect(c.x - rr, c.y - rr, 2 * rr + 1, 2 * rr + 1);
      const int32_t step = TRIG_MAX_ANGLE / 8;
      for (int i = 0; i < 8; i++) {
        graphics_draw_arc(ctx, box, GOvalScaleModeFitCircle, i * step, i * step + step / 2);
      }
      break;
    }
    default:
      graphics_draw_circle(ctx, c, rr);
      if (!big) {
        graphics_draw_circle(ctx, c, rr - 1);
      }
      break;
  }
  graphics_context_set_stroke_width(ctx, 1);
  graphics_context_set_antialiased(ctx, true);
}

/** A mark's colour on a black row, or on the white selected row. */
GColor state_colour(uint8_t state, bool on_white) {
#if defined(PBL_COLOR)
  switch (state) {
    case STATE_GOOD:
      return on_white ? GColorIslamicGreen : GColorGreen;
    case STATE_PENDING:
      return on_white ? GColorWindsorTan : GColorChromeYellow;
    case STATE_BAD:
      return on_white ? GColorDarkCandyAppleRed : GColorSunsetOrange;
    default:
      return on_white ? GColorDarkGray : GColorLightGray;
  }
#else
  (void)state;
  return on_white ? GColorBlack : GColorWhite;
#endif
}

/** The colour of an item's band. */
GColor state_band(uint8_t state) {
#if defined(PBL_COLOR)
  switch (state) {
    case STATE_GOOD: return GColorIslamicGreen;
    case STATE_PENDING: return GColorChromeYellow;
    case STATE_BAD: return GColorDarkCandyAppleRed;
    default: return GColorDarkGray;
  }
#else
  (void)state;
  return GColorBlack;
#endif
}

/** Black on a light colour (amber), else white. */
GColor ink_on(GColor band) {
  const int lum = 299 * band.r + 587 * band.g + 114 * band.b;  // 0..3000
  return lum > 1600 ? GColorBlack : GColorWhite;
}

// ---------------------------------------------------------------- words

/** '06:01', or '6:01am' when the watch is set to 12-hour time. */
void format_clock(char *buf, size_t size, const struct tm *t) {
  if (clock_is_24h_style()) {
    snprintf(buf, size, "%02d:%02d", t->tm_hour, t->tm_min);
  } else {
    const int hour = t->tm_hour % 12 ? t->tm_hour % 12 : 12;
    snprintf(buf, size, "%d:%02d%s", hour, t->tm_min, t->tm_hour < 12 ? "am" : "pm");
  }
}

/** 'Updated 15:18', or 'Updated Thu 15:18' another day; capitals for a label. */
void format_updated(char *buf, size_t size, time_t when, bool upper) {
  struct tm at = *localtime(&when);
  const time_t now = time(NULL);
  const struct tm today = *localtime(&now);
  char clock[12];
  format_clock(clock, sizeof(clock), &at);
  if (at.tm_year == today.tm_year && at.tm_yday == today.tm_yday) {
    snprintf(buf, size, "Updated %s", clock);
  } else {
    char day[8];
    strftime(day, sizeof(day), "%a", &at);
    snprintf(buf, size, "Updated %s %s", day, clock);
  }
  if (upper) {
    for (char *c = buf; *c; c++) {
      if (*c >= 'a' && *c <= 'z') {
        *c -= 'a' - 'A';
      }
    }
  }
}

bool updated_is_fresh(void) {
  if (g_app.updated <= 0) {
    return false;
  }
  const time_t age = time(NULL) - g_app.updated;
  return age >= -60 && age <= FRESH_S;
}

/** What's in a Kind's list, in a few words: '12 unread', '3 waiting', '4 open · 1 failing'.
 * `brief`, for a band too narrow for that: the part that matters, '1 failing'. */
void format_count(char *buf, size_t size, uint8_t kind, bool brief) {
  const Summary *s = &g_app.summary;
  switch (kind) {
    case KIND_NOTIFICATION:
      if (s->unread) {
        snprintf(buf, size, "%u unread", s->unread);
      } else {
        ib_copy(buf, "All read", size);
      }
      break;
    case KIND_REVIEW:
      if (s->reviews) {
        snprintf(buf, size, "%u waiting", s->reviews);
      } else {
        ib_copy(buf, "None waiting", size);
      }
      break;
    case KIND_PR:
      if (!s->prs) {
        ib_copy(buf, "None open", size);
      } else if (s->failing && brief) {
        snprintf(buf, size, "%u failing", s->failing);
      } else if (s->failing) {
        snprintf(buf, size, "%u open \xc2\xb7 %u failing", s->prs, s->failing);
      } else {
        snprintf(buf, size, "%u open", s->prs);
      }
      break;
    case KIND_BUILD:
      if (s->broken && brief) {
        snprintf(buf, size, "%u failing", s->broken);
      } else if (s->broken) {
        snprintf(buf, size, "%u %s \xc2\xb7 %u failing", s->builds, s->builds == 1 ? "repo" : "repos",
                 s->broken);
      } else {
        snprintf(buf, size, "%u %s", s->builds, s->builds == 1 ? "repo" : "repos");
      }
      break;
    case KIND_REPO:
      ib_copy(buf, brief ? "Pick a repo" : "Pick a repository", size);
      break;
    default:
      buf[0] = '\0';
      break;
  }
}

const char *kind_label(uint8_t kind) {
  switch (kind) {
    case KIND_NOTIFICATION: return "NOTIFICATIONS";
    case KIND_REVIEW: return "REVIEWS";
    case KIND_PR: return "MY PULL REQUESTS";
    case KIND_BUILD: return "BUILDS";
    case KIND_REPO: return "NEW ISSUE";
    default: return "INBOX";
  }
}

const char *group_label(uint8_t group) {
  switch (group) {
    case GROUP_REVIEW: return "REVIEW REQUESTED";
    case GROUP_MENTIONED: return "MENTIONED";
    case GROUP_ASSIGNED: return "ASSIGNED";
    case GROUP_BUILDS: return "BUILDS";
    default: return "OTHER";
  }
}
