import React from 'react';
import useAuthStore from '../stores/authStore.js';

export default function Dashboard() {
    const { user, logout } = useAuthStore();

    return (
        <div className="min-h-screen bg-gray-100">
            {/* Header */}
            <div className="bg-white shadow-sm">
                <div className="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
                    <div className="flex items-center space-x-4">
                        <i className="fa-brands fa-whatsapp text-3xl text-green-500"></i>
                        <h1 className="text-xl font-semibold">WhatsApp Clone</h1>
                    </div>
                    <div className="flex items-center space-x-4">
                        <span className="text-gray-600">Welcome, {user?.username}</span>
                        <button
                            onClick={logout}
                            className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition"
                        >
                            <i className="fa-solid fa-sign-out-alt mr-2"></i>
                            Logout
                        </button>
                    </div>
                </div>
            </div>

            {/* Main content */}
            <div className="max-w-7xl mx-auto px-4 py-8">
                <div className="bg-white rounded-lg shadow-lg p-8 text-center">
                    <i className="fa-regular fa-face-smile text-6xl text-green-500 mb-4"></i>
                    <h2 className="text-2xl font-bold text-gray-800 mb-2">
                        Welcome to WhatsApp Clone!
                    </h2>
                    <p className="text-gray-600 mb-6">
                        You have successfully logged in. The full dashboard is coming soon.
                    </p>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-8">
                        <div className="p-4 bg-gray-50 rounded-lg">
                            <i className="fa-regular fa-message text-2xl text-green-500 mb-2"></i>
                            <h3 className="font-semibold">Messages</h3>
                            <p className="text-sm text-gray-500">Coming soon</p>
                        </div>
                        <div className="p-4 bg-gray-50 rounded-lg">
                            <i className="fa-regular fa-user text-2xl text-green-500 mb-2"></i>
                            <h3 className="font-semibold">Contacts</h3>
                            <p className="text-sm text-gray-500">Coming soon</p>
                        </div>
                        <div className="p-4 bg-gray-50 rounded-lg">
                            <i className="fa-regular fa-calendar text-2xl text-green-500 mb-2"></i>
                            <h3 className="font-semibold">Groups</h3>
                            <p className="text-sm text-gray-500">Coming soon</p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}