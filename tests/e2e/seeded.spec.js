// Behavioral tests against the REAL built extension, with state seeded into
// chrome.storage (no login, no network). Each test gets a fresh extension profile
// from the `context` fixture, so storage starts empty.
import { test, expect } from './fixtures.js'

const DAY = 86400000
const HOUR = 3600000
const auth = { user: 'gw_tester', origin: 'https://patriots.win', apiKey: 'k', apiSecret: 's' }

// a RemovedRecord with sensible defaults
const rr = o => ({
    id: 1, uuid: 'u1', type: 'comment', post_uuid: 'p1', community: 'TheDonald', title: '', text: 'a removed comment',
    text_loading: false, status: 'publicly_removed', removal_source: 'communityFilter', created: 0,
    observed_utc: Date.now(), unseen: true, source: 'own', ...o,
})
// an OtherItem with sensible defaults
const oi = o => ({
    post_id: 1, author: 'someone', community: 'TheDonald', created: Date.now(), title: '', text: '',
    watched_at: Date.now(), is_removed: false, removal_source: '', removal_count: 0, visible_count: 0,
    recorded: false, ...o,
})
const url = (id, p) => `chrome-extension://${id}/src/${p}`

// open an extension page (gives us chrome.storage), seed it, return the page
async function seed(context, extensionId, data) {
    const page = await context.newPage()
    await page.goto(url(extensionId, 'options.html'))
    await page.evaluate(d => new Promise(r => chrome.storage.local.set(d, () => r(1))), data)
    return page
}

test.describe('popup states', () => {
    test('alarm: lists your currently-removed items', async ({ context, extensionId }) => {
        const now = Date.now()
        const page = await seed(context, extensionId, {
            auth,
            last_origin: 'https://patriots.win',
            own_items: { 1: {}, 2: {} },
            removed: {
                1: rr({ id: 1, uuid: 'a1', text: 'this comment got pulled', observed_utc: now - 6 * HOUR, created: now - 12 * HOUR }),
                2: rr({ id: 2, uuid: 'a2', type: 'post', title: 'a removed post title', observed_utc: now - 5 * DAY, created: now - 8 * DAY }),
            },
        })
        await page.goto(url(extensionId, 'popup.html'))
        await expect(page.getByText(/currently removed/i)).toBeVisible()
        await expect(page.getByText('this comment got pulled')).toBeVisible()
        await expect(page.getByText('a removed post title')).toBeVisible()
        await expect(page.getByText('u/gw_tester')).toBeVisible()
        // connected → NOT the disconnected/reconnect state
        await expect(page.getByRole('button', { name: 'Reconnect' })).toHaveCount(0)
    })

    test('clear: all-clear band + watching summary', async ({ context, extensionId }) => {
        const page = await seed(context, extensionId, {
            auth,
            last_origin: 'https://patriots.win',
            own_items: { 1: {}, 2: {}, 3: {} },
            removed: {},
        })
        await page.goto(url(extensionId, 'popup.html'))
        await expect(page.getByText(/all clear/i)).toBeVisible()
        await expect(page.getByText(/Watching 3 of your items/i)).toBeVisible()
    })

    test('watching the active user page shows the confirmation', async ({ context, extensionId }) => {
        const page = await seed(context, extensionId, {
            auth,
            last_origin: 'https://patriots.win',
            removed: {},
            watch_sources: {
                'user:someuser': { key: 'user:someuser', kind: 'user', name: 'SomeUser', added: Date.now(), items: {} },
            },
        })
        // make the popup think the active tab is that user's page
        await page.addInitScript(u => {
            try {
                chrome.tabs.query = () => Promise.resolve([{ url: u, id: 1, active: true }])
            } catch (e) {}
        }, 'https://patriots.win/u/SomeUser/')
        await page.goto(url(extensionId, 'popup.html'))
        await expect(page.getByText(/Watching this user/i)).toBeVisible()
        await expect(page.getByText('u/SomeUser')).toBeVisible()
        await expect(page.getByRole('button', { name: 'Unwatch' })).toBeVisible()
    })
})

test.describe('insights page', () => {
    test('empty state when nothing is detected', async ({ context, extensionId }) => {
        const page = await context.newPage()
        await page.goto(url(extensionId, 'insights.html'))
        await expect(page.getByText('Insights')).toBeVisible()
        await expect(page.getByText(/No removals detected yet/i)).toBeVisible()
    })

    test('renders metrics, chart, distributions and export', async ({ context, extensionId }) => {
        const now = Date.now()
        const own = {}
        for (let i = 0; i < 12; i++) own[i] = {}
        const page = await seed(context, extensionId, {
            own_items: own,
            removed: {
                1: rr({ id: 1, uuid: 'a1', removal_source: 'communityFilter', observed_utc: now - 5 * DAY, created: now - 8 * DAY }),
                2: rr({ id: 2, uuid: 'a2', type: 'post', removal_source: 'nuke', source: 'other', author: 'bob', observed_utc: now - 1 * DAY, created: now - 2 * DAY }),
            },
        })
        await page.goto(url(extensionId, 'insights.html'))
        await expect(page.getByText('removals detected')).toBeVisible()
        await expect(page.getByText(/of your 12 monitored items removed/i)).toBeVisible()
        await expect(page.getByText('Removals — last 14 days')).toBeVisible()
        await expect(page.getByText('By removal source')).toBeVisible()
        await expect(page.getByRole('button', { name: 'Export JSON' })).toBeVisible()
        await expect(page.getByRole('button', { name: 'Export CSV' })).toBeVisible()
    })
})

test('watching page: groups by type and shows the in-row All-comments toggle', async ({ context, extensionId }) => {
    const page = await seed(context, extensionId, {
        last_origin: 'https://patriots.win',
        watch_sources: { 'user:bob': { key: 'user:bob', kind: 'user', name: 'Bob', added: Date.now(), items: {} } },
        other_items: {
            10: oi({ id: 10, uuid: 'a10', type: 'post', post_uuid: 'a10', title: 'A watched post', watch_comments: true }),
            11: oi({ id: 11, uuid: 'a11', type: 'comment', post_uuid: 'a11', text: 'a watched comment' }),
        },
    })
    await page.goto(url(extensionId, 'manage.html'))
    await expect(page.getByText('People & communities')).toBeVisible()
    await expect(page.getByText('u/Bob')).toBeVisible()
    await expect(page.getByText('A watched post')).toBeVisible()
    await expect(page.getByText('All comments')).toBeVisible()
    await expect(page.getByRole('switch')).toBeVisible() // the All-comments toggle (on)
})

test('help page renders the guide + the Hidden caveat', async ({ context, extensionId }) => {
    const page = await context.newPage()
    await page.goto(url(extensionId, 'help.html'))
    await expect(page.getByText('How it works')).toBeVisible()
    await expect(page.getByRole('heading', { name: /Other people's content/i })).toBeVisible()
    await expect(page.getByText(/is a precaution/i)).toBeVisible()
})

test('history filter narrows to your / others content', async ({ context, extensionId }) => {
    const now = Date.now()
    const page = await seed(context, extensionId, {
        last_origin: 'https://patriots.win',
        removed: {
            1: rr({ id: 1, uuid: 'a1', text: 'my own removed comment', source: 'own', observed_utc: now - 1 * DAY }),
            2: rr({ id: 2, uuid: 'a2', text: 'someone elses removed comment', source: 'other', author: 'bob', observed_utc: now - 2 * DAY }),
        },
    })
    await page.goto(url(extensionId, 'history.html'))
    await expect(page.getByText('my own removed comment')).toBeVisible()
    await expect(page.getByText('someone elses removed comment')).toBeVisible()

    await page.selectOption('select', 'others')
    await expect(page.getByText('someone elses removed comment')).toBeVisible()
    await expect(page.getByText('my own removed comment')).toHaveCount(0)

    await page.selectOption('select', 'yours')
    await expect(page.getByText('my own removed comment')).toBeVisible()
    await expect(page.getByText('someone elses removed comment')).toHaveCount(0)
})
