/**
 * External dependencies
 */
const fs     = require('fs').promises;
const core   = require( '@actions/core' );
const github = require( '@actions/github' );

const promiseAny = require( 'promise.any' );
promiseAny.shim();

/**
 * WordPress dependencies
 */
import {
	createNewPost,
	searchForBlock,
	deactivatePlugin,
	uninstallPlugin,
} from '@wordpress/e2e-test-utils';

/**
 * Internal dependencies
 */

import {
	getThirdPartyBlocks,
	expectWithMessage,
	removeAllBlocks,
	getAllLoadedScripts,
	getAllLoadedStyles,
} from './utils';
import {
	wporgHttpCallback,
	setOutput,
} from './utils/wporg-callback';
import { waitUntilNetworkIdle } from './utils/network-idle';

// Filter browser requests.
// - Ensure that wp-content/*.(css|js) always 404's instead of matching WordPress.
// - favicons are not needed.
require( './utils/filter-requests' );

// We don't want to see warnings during these tests
console.warn = () => {};

// Depending on the environment, the url may be encoded or not.
const urlMatch = ( url ) => {
	const urlPart = '/wp/v2/block-directory/search';
	const encoded = encodeURIComponent( urlPart );
	return url.indexOf( urlPart ) >= 0 || url.indexOf( encoded ) >= 0;
};

const payload = github.context.payload.client_payload || {};
const pluginSlug = process.env.PLUGIN_SLUG || payload.slug;
const searchTerm = `slug:${ pluginSlug }`;

// Variable to hold any encounted JS errors.
let jsError = false;
page.on( 'pageerror', ( error ) => {
	jsError = error.toString();

	console.log( error );
} );

// Track the last 404 response
let lastFourOhFour = false;
page.on('response', ( response ) => {
	const url = response.url()
		.replace(
			/^http:\/\/[^/]+\/(wp-content\/plugins\/[^/]+\/)/,
			''
		)
		.replace( /[?&]ver=[a-z0-9.-]+/, '' );

	if ( 404 === response.status() ) {
		lastFourOhFour = url;
	}
} );

core.info( `
--------------------------------------------------------------
Running Tests for "${ pluginSlug }"
--------------------------------------------------------------
` );

// Send the URL to this actions run
if ( process.env.GITHUB_RUN_ID ) {
	setOutput( 'lastRunURL', `https://github.com/${ process.env.GITHUB_REPOSITORY }/actions/runs/${ process.env.GITHUB_RUN_ID }` );
}

describe( `Block Directory Tests`, () => {
	beforeEach( async () => {
		await createNewPost();
		await removeAllBlocks();

		jsError = false;
	} );

	afterAll( async () => {
		await wporgHttpCallback( pluginSlug );

		await deactivatePlugin( pluginSlug );
		await uninstallPlugin( pluginSlug );
	} );

	// Be patient.
	page.setDefaultTimeout( 60000 );

	let freshScripts = [];
	let freshStyles = [];

	it( 'Block returns from API and installs', async () => {
		try {
			// Determine the loaded assets, store it for the next test.
			freshScripts = await getAllLoadedScripts();
			freshStyles = await getAllLoadedStyles();

			await searchForBlock( searchTerm );

			const finalResponse = await page.waitForResponse(
				( response ) =>
					urlMatch( response.url() ) &&
					response.status() === 200 &&
					response.request().method() === 'GET' // We don't want the OPTIONS request
			);

			const resp = await finalResponse.json();

			await expectWithMessage( () => {
				expect( Array.isArray( resp ) ).toBeTruthy();
			}, `The search result for "${ pluginSlug }" isn't an array.` );

			await expectWithMessage( () => {
				expect( resp.length ).toBeGreaterThan( 0 );
			}, `We found no matching blocks for "${ pluginSlug }" in the directory.` );

			const addBtnSelector =
				'.block-directory-downloadable-blocks-list button:first-child';
			await page.waitForSelector( addBtnSelector );

			// Output a screenshot of the Search Results for debugging.
			await (
				await page.$(
					'.block-directory-downloadable-blocks-list button:first-child'
				)
			 ).screenshot( { path: 'screenshots/searchResults.png' } );

			setOutput( 'screenshotSearchResults', 'file:screenshots/searchResults.png' );

			// Add the block
			await page.click( addBtnSelector );

			// Watch the button go busy…
			await page.waitForSelector( addBtnSelector + '.is-busy' );

			// Then either non-busy or removed.
			await Promise.any( [
				// This is the expected case, the inserter switched back to block-types-list.
				page.waitForSelector(
					'button.block-editor-block-types-list-item'
				),
				// But in some cases the inserted block has a restricted set of "children",
				// which interacts with the filter & Block Directory, so the add button
				// doesn't go away, it just becomes "un-busy".
				// See https://github.com/WordPress/gutenberg/pull/24148
				page.waitForSelector( addBtnSelector + ':not(.is-busy)' ),
			] );

			// And wait for the Network to go idle (Assets inserted)
			await waitUntilNetworkIdle( 'networkidle0' );

			// Check to see if there was a specific reason for a failure.
			let error = await page.evaluate( () => {
				const el = document.querySelector(
					'.block-directory-downloadable-block-notice.is-error .block-directory-downloadable-block-notice__content'
				);
				return el ? el.innerText : false;
			} );

			if ( error && 'Error loading asset.' === error && lastFourOhFour ) {
				// Alter the error slightly.
				error = `Error loading asset "${ lastFourOhFour }"`;
			}

			await expectWithMessage( () => {
				expect( error ).toBeFalsy();
			}, `Couldn't install "${ pluginSlug }"; '${ error }'` );

			const blocks = await getThirdPartyBlocks();

			await expectWithMessage( () => {
				expect( blocks.length ).toBeGreaterThan( 0 );
			}, `Couldn't install "${ pluginSlug }". No registered blocks detected.` );

			// check to see if it errored.
			await expectWithMessage( () => {
				expect( jsError ).toBeFalsy();
			}, `Javascript error: ${ jsError }` );

			// wait for the element to exist in the editor
			await expectWithMessage( async function () {
					await page.waitForSelector(
						`div[data-type="${ blocks[ 0 ].name }"]`
					)
				},
				`Expected block "${ blocks[ 0 ].name }" not added to the document after install.`
			);

			// Get a screenshot of the block.
			try {
				await (
					await page.waitForSelector(
						'.is-root-container .wp-block:not([data-type^="core/"])'
					)
				 ).screenshot( { path: 'screenshots/block.png' } );

				setOutput( 'screenshotBlock', 'file:screenshots/block.png' );
			} catch ( e ) {
				// Ignore any error here, the test should still succeed.
			}

			setOutput( 'error', '' );
			setOutput( 'success', true );
		} catch ( e ) {
			core.setFailed( e.message );
			setOutput( 'error', jsError || e.message );
			setOutput( 'success', false );

			throw e;
		}
	} );

	it( 'Block Installed - Extract Scripts & Styles required', async () => {
		// Page reloaded from previous test.
		await expectWithMessage( () => {
			expect( freshScripts.length ).toBeGreaterThan( 0 );
			expect( freshStyles.length ).toBeGreaterThan( 0 );
		}, `The previous test did not load scripts/styles.`, false );

		const blocks = await getThirdPartyBlocks();
		await expectWithMessage( () => {
			expect( blocks.length ).toBeGreaterThan( 0 );
		}, `Block not installed.`, false );

		const loadedScripts = await getAllLoadedScripts();
		const loadedStyles = await getAllLoadedStyles();

		const scriptDiff = loadedScripts.filter(
			( x ) => ! freshScripts.some( ( y ) => x.id === y.id )
		);
		const styleDiff = loadedStyles.filter(
			( x ) => ! freshStyles.some( ( y ) => x.id === y.id )
		);

		setOutput( 'scripts', scriptDiff );
		setOutput( 'styles', styleDiff );
		setOutput( 'blocks', blocks );
	} );

} );
