import * as puppeteer from 'puppeteer';
import {Browser, Page, Request, Response, Headers} from "puppeteer";

import AwaitLock = require("await-lock");
import _ = require("lodash/object");

import {Logger} from "winston";


/**
 * The endpoints that are available for scraping. (Hashtags, Locations, Users)
 */
enum Endpoints {
    HASHTAG = "https://instagram.com/explore/tags/",
    LOCATION = "https://instagram.com/explore/locations/",
    USER = "https://instagram.com/"
}

/**
 * The states of progress that the API can be in
 */
enum Progress {
    LAUNCHING = "Launching",
    OPENING = "Navigating",
    SCRAPING = "Scraping",
    GRAFTING = "Grafting",
    CLOSING = "Closing",

    PAUSED = "Paused",
    ABORTED = "Request aborted"
}

/**
 * A fixed-size queue of post ids
 */
class PostIdQueue {
    private size: number = 10000;
    private ids: Set<string> = new Set<string>();

    /**
     * Add a post id to the queue. The least-recently inserted id is popped off the queue when it reaches its max size
     * @return true if the id was already in the queue, false if not.
     */
    public add(id: string): boolean {
        // Check if already in list
        let contains = this.ids.has(id);

        // Pop id when size limit reached
        if (this.ids.size >= this.size) {
            this.pop();
        }

        // Add id
        this.ids.add(id);

        // Return if id was already in list
        return contains;
    }

    pop() {
        for (let i of this.ids)
            return this.ids.delete(i);
    }
}

/**
 * Optional arguments for the API
 */
export interface ApiOptions {
    total?: number;
    headless?: boolean;
    logger?: Logger;
    silent?: boolean;
    sleepTime?: number;
}

/**
 * An Instagram API object
 */
export class Instagram implements AsyncIterableIterator<object> {
    // Puppeteer state
    private browser: Browser;
    private page: Page;
    private readonly headless: boolean;

    // General information
    private readonly id: string;

    // List of scraped posts and lock
    private postBuffer: Array<object> = [];
    private postBufferLock: AwaitLock = new AwaitLock();

    // Request and Response buffers and locks
    private requestBuffer: Array<Request> = [];
    private requestBufferLock: AwaitLock = new AwaitLock();
    private responseBuffer: Array<Response> = [];
    private responseBufferLock: AwaitLock = new AwaitLock();

    // Grafting state
    private graft: boolean = false;
    private lastURL: string;
    private lastHeaders: Headers;

    // Hibernation due to rate limiting
    private hibernate: boolean = false;
    private hibernationTime: number = 60 * 20;

    // The endpoint URL used for scraping
    private readonly url: string;

    // URL containing API information
    private readonly catchURL: string = "https://www.instagram.com/graphql/query";

    // Strings denoting the access methods of API objects
    private readonly pageQuery: string;
    private readonly edgeQuery: string;

    // Iteration state is finished
    private finished: boolean;

    // Cache of post ids
    private postIds: PostIdQueue = new PostIdQueue();

    // Iteration variables
    private readonly total: number;
    private index: number = 0;
    private jumps: number = 0;
    private jumpMod: number = 50;

    // Output
    private outputLength: number = 0;
    private readonly silent: boolean = false;

    // Sleep time remaining
    private sleepRemaining: number = 0;

    // Length of time to sleep for
    private readonly sleepTime: number = 2;

    // Scraping paused
    private paused: boolean = false;

    // Logging object
    private logger: Logger;

    constructor(endpoint: Endpoints, id: string, pageQuery: string, edgeQuery: string, options: ApiOptions = {}) {
        this.id = id;
        this.total = options.total;
        this.url = Instagram.constructURL(endpoint, id);
        this.pageQuery = pageQuery;
        this.edgeQuery = edgeQuery;
        this.headless = options.headless;
        this.logger = options.logger;
        this.silent = options.silent;
        this.sleepTime = options.sleepTime;
    }

    /**
     * Create url from endpoint and id
     */
    static constructURL(endpoint: Endpoints, id: String) {
        return endpoint + id;
    }

    /**
     * Create the browser and page, then visit the url
     */
    async constructPage() {
        // Browser args
        let args = [];
        if (process.env.NO_SANDBOX) {
            args.push('--no-sandbox');
            args.push('--disable-setuid-sandbox');
        }

        // Launch browser
        this.progress(Progress.LAUNCHING);
        this.browser = await puppeteer.launch({
            headless: this.headless,
            args: args
        });

        // Visit page
        this.page = await this.browser.newPage();
        this.progress(Progress.OPENING);
        await this.page.goto(this.url);
    }


    /**
     * Construct page and add listeners
     */
    async start() {
        // Build page and visit url
        await this.constructPage();

        // Add event listeners for requests and responses
        await this.page.setRequestInterception(true);
        this.page.on("request", (req) => this.interceptRequest(req));
        this.page.on("response", (res) => this.interceptResponse(res));
        this.page.on("requestfailed", (res) => this.interceptFailure(res));

        // Ignore dialog boxes
        this.page.on("dialog", (dialog) => dialog.dismiss());

        // Log errors
        this.page.on("error", (error) => this.logger.error(error))
    }

    /**
     * Close the page and browser
     */
    async stop() {
        this.progress(Progress.CLOSING);
        // // Clear request buffers
        // await this.requestBufferLock.acquireAsync();
        // this.requestBuffer = [];
        // this.requestBufferLock.release();
        //
        // // Clear response buffers
        // await this.responseBufferLock.acquireAsync();
        // this.responseBuffer = [];
        // this.responseBufferLock.release();

        // Close page and browser
        await this.page.close();
        await this.browser.close();
    }

    /**
     * Toggle pausing data collection
     */
    public pause() {
        this.paused = !this.paused;
    }

    /**
     * Pause and wait until resumed
     */
    async waitResume() {
        // Pause for 200 milliseconds
        function f() {
            return new Promise(
                resolve => {
                    setTimeout(resolve, 200)
                }
            );
        }

        // Pause until pause toggled
        while (this.paused == true) {
            this.progress(Progress.PAUSED);
            await f();
        }
    }

    /**
     * Pop a post of the postBuffer (using locks). Returns null if no posts in buffer
     */
    async postPop() {
        let post = null;
        await this.postBufferLock.acquireAsync();
        if (this.postBuffer.length > 0) {
            post = this.postBuffer.shift();
        }
        this.postBufferLock.release();
        return post;
    }

    /**
     * Generator of posts on page
     */
    public async* itr() {
        while (true) {
            // Get more posts, then yield the posts in the buffer
            let more = await this.getNext();
            if (more) {
                // Pop post from buffer
                let post = await this.postPop();

                // Yield valid post, else continue and wait for more
                if (post) {
                    yield post;
                }
            } else {
                // Yield leftover posts from buffer
                let post = await this.postPop();
                while (post) {
                    yield post;
                    post = await this.postPop();
                }
                this.logger.info("No more posts available");
                break;
            }
        }
        await this.stop();
    }

    /**
     * Match the url to the url used in API requests
     */
    private matchURL(url: string) {
        return url.slice(0, this.catchURL.length) == this.catchURL
    }

    /**
     * Print progress to stdout
     */
    private progress(state: Progress) {
        // End if silent
        if (this.silent) {
            return;
        }

        // Calculate total
        let total = this.total == 0 ? "Unlimited" : this.total;

        // Generate output string
        let out = `Id: ${this.id} | State: ${state} | Sleeping: ${this.sleepRemaining} | Total: ${total} | Scraped: ${this.index}`;

        // Calculate empty padding
        let repeatCount = out.length - this.outputLength;
        let padding = "  ";
        if (repeatCount > 0 && this.outputLength > 0) {
            padding = " ".repeat(repeatCount)
        }

        // Update output length
        if (out.length > this.outputLength) {
            this.outputLength = out.length;
        }

        this.logger.info(out);

        // Print output
        process.stdout.write("\r" + out + padding);
    }


    /**
     * Add request to the request buffer
     */
    private async interceptRequest(req: Request) {
        await this.requestBufferLock.acquireAsync();
        this.requestBuffer.push(req);
        await this.requestBufferLock.release();
    }

    /**
     * Add the response to the response buffer
     */
    private async interceptResponse(res: Response) {
        await this.responseBufferLock.acquireAsync();
        this.responseBuffer.push(res);
        await this.responseBufferLock.release();
    }

    /**
     * Log failed requests
     */
    private async interceptFailure(req: Request) {
        this.logger.info("Failed: " + req.url());
        this.progress(Progress.ABORTED);
    }

    /**
     * Process the requests in the request buffer
     */
    private async processRequests() {
        await this.requestBufferLock.acquireAsync();

        let disableGraft = false;
        for (let req of this.requestBuffer) {
            // Match url
            if (!this.matchURL(req.url())) {
                continue;
            } else {
                disableGraft = true;
            }

            // Switch url and headers if grafting enabled, else store them
            let reqURL = req.url();
            let reqHeaders = req.headers();
            if (this.graft) {
                reqURL = this.lastURL;
                reqHeaders = this.lastHeaders;
            } else {
                this.lastURL = req.url();
                this.lastHeaders = req.headers();
            }

            // Get response
            await req.continue({
                url: reqURL,
                headers: reqHeaders
            })
        }

        // Switch off grafting if enabled and requests processed
        if (this.graft && disableGraft) {
            this.graft = false;
        }

        // Clear buffer and release
        this.requestBuffer = [];
        this.requestBufferLock.release();
    }

    /**
     * Process the responses in the response buffer
     */
    private async processResponses() {
        await this.responseBufferLock.acquireAsync();

        for (let res of this.responseBuffer) {
            // Match url
            if (!this.matchURL(res.url())) {
                continue;
            }

            // Get JSON data
            let data: JSON;
            try {
                data = await res.json()
            } catch (e) {
                this.logger.error("Error processing response JSON");
                this.logger.error(e);
            }

            // Check for rate limiting
            if (data && 'status' in data && data['status'] == 'fail') {
                this.logger.info('Rate limited');
                this.hibernate = true;
                continue;
            }

            // Check for next page
            if (!_.get(data, this.pageQuery, false)) {
                this.logger.info('No posts remaining');
                this.finished = true;
            }

            // Get posts
            let posts = _.get(data, this.edgeQuery, []);
            for (let post of posts) {
                let postId = post['node']['id'];

                // Check it hasn't already been cached
                let contains = this.postIds.add(postId);
                if (contains) {
                    this.logger.info("Duplicate id found: " + postId);
                    continue;
                }

                // Add to postBuffer
                if (this.index < this.total || this.total == 0) {
                    this.index++;
                    await this.postBufferLock.acquireAsync();
                    this.postBuffer.push(post);
                    this.postBufferLock.release()
                } else {
                    this.finished = true;
                    break;
                }
            }
        }

        // Clear buffer and release
        this.responseBuffer = [];
        this.responseBufferLock.release();
    }

    /**
     * Manipulate the page to stimulate a request
     */
    private async jump() {
        // Jump up
        await this.page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight - 400);
        });

        // Wait for execution
        // await this.sleep(0.5);

        // Jump down
        await this.page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
        });

        // Move mouse randomly
        let width = this.page.viewport()['width'];
        let height = this.page.viewport()['height'];
        await this.page.mouse.move(Math.round(width * Math.random()), Math.round(height * Math.random()));

        ++this.jumps;
    }

    /**
     * Halt execution
     * @param time Seconds
     */
    private async sleep(time) {
        for (let i = time; i > 0; i--) {
            this.sleepRemaining = i;
            this.progress(Progress.SCRAPING);
            await this.sleepPromise();
        }
    }

    /**
     * Promise to sleep for one second
     */
    private async sleepPromise() {
        return new Promise(
            resolve => {
                setTimeout(resolve, 1000)
            }
        );
    }

    /**
     * Clear request and response buffers
     */
    private async initiateGraft() {
        this.progress(Progress.GRAFTING);

        // Close browser and page
        await this.stop();

        // Enable grafting
        this.graft = true;

        // Re-start page
        await this.start();
    }

    /**
     * Stimulate the page until responses gathered
     */
    private async getNext() {
        this.progress(Progress.SCRAPING);
        while (true) {
            // Process results (if any)
            await this.processRequests();
            await this.processResponses();

            // Check if posts gathered
            await this.postBufferLock.acquireAsync();
            if (this.postBuffer.length > 0) {
                this.postBufferLock.release();
                break
            }
            this.postBufferLock.release();

            // Check if finished
            if (this.finished) {
                break;
            }

            // Pause if paused
            await this.waitResume();

            // Interact with page to stimulate request
            await this.jump();

            // Enable grafting if required
            if (this.jumps % this.jumpMod == 0) {
                await this.initiateGraft();
            }

            // Sleep
            await this.sleep(this.sleepTime);

            // Hibernate if rate-limited
            if (this.hibernate) {
                await this.sleep(this.hibernationTime);
                this.hibernate = false;
            }
        }

        // Check if posts in buffer
        await this.postBufferLock.acquireAsync();
        let postBufferEmpty = this.postBuffer.length > 0;
        await this.postBufferLock.release();

        // Return true if more data, false otherwise
        return !(postBufferEmpty && this.finished);
    }
}

/**
 * An Instagram hashtag API wrapper
 */
export class Hashtag extends Instagram {
    constructor(id: string, options: object = {}) {
        let pageQuery = "data.hashtag.edge_hashtag_to_media.page_info.has_next_page";
        let edgeQuery = "data.hashtag.edge_hashtag_to_media.edges";
        super(Endpoints.HASHTAG, id, pageQuery, edgeQuery, options)
    }
}

/**
 * An Instagram location API wrapper
 */
export class Location extends Instagram {
    constructor(id: string, options: object = {}) {
        let pageQuery = "data.location.edge_location_to_media.page_info.has_next_page";
        let edgeQuery = "data.location.edge_location_to_media.edges";
        super(Endpoints.LOCATION, id, pageQuery, edgeQuery, options)
    }
}

/**
 * An Instagram user API wrapper
 */
export class User extends Instagram {
    constructor(id: string, options: object = {}) {
        let pageQuery = "data.user.edge_owner_to_timeline_media.page_info.has_next_page";
        let edgeQuery = "data.user.edge_owner_to_timeline_media.edges";
        super(Endpoints.USER, id, pageQuery, edgeQuery, options)
    }
}
